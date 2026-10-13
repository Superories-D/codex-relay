import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, Quota } from "../shared/types";
import { Store, atomicWrite } from "./store";
import { Rpc } from "./rpc";
import { errorKind, isExhausted, parseQuotas } from "./quota";
import { redact } from "./redact";
export interface Cipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export interface AuthCache {
  auth_mode?: string;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}
function claims(token: string): any {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}
export function parseAuth(text: string): {
  auth: AuthCache;
  identity: string;
  email: string;
  plan: string;
} {
  const auth = JSON.parse(text);
  if (
    auth.OPENAI_API_KEY ||
    typeof auth.tokens?.access_token !== "string" ||
    !auth.tokens.access_token ||
    typeof auth.tokens?.id_token !== "string"
  )
    throw new Error(
      "仅支持官方 ChatGPT auth.json；API Key 和未知凭据格式不参与订阅额度轮换",
    );
  const id = claims(auth.tokens.id_token);
  const access = claims(auth.tokens.access_token);
  const info =
    id["https://api.openai.com/auth"] ??
    access["https://api.openai.com/auth"] ??
    {};
  const identity = auth.tokens.account_id ?? info.chatgpt_account_id;
  if (typeof identity !== "string" || !identity)
    throw new Error("认证缓存缺少 ChatGPT account_id");
  auth.tokens.account_id = identity;
  return {
    auth,
    identity,
    email: String(
      id.email ??
        access["https://api.openai.com/profile"]?.email ??
        "ChatGPT account",
    ),
    plan: String(info.chatgpt_plan_type ?? "unknown"),
  };
}
export class Accounts {
  private locks = new Map<string, Promise<unknown>>();
  private login?: {
    id: string;
    rpc: Rpc;
    loginId: string;
    timer: NodeJS.Timeout;
  };
  loginDisplay?: { accountId: string; url: string; code?: string };
  loginError?: string;
  busy = new Set<string>();
  constructor(
    private store: Store,
    private cipher: Cipher,
    private changed: () => void,
  ) {}
  private vault(id: string) {
    return path.join(this.store.root, "vault", `${id}.vault`);
  }
  async auth(id: string): Promise<AuthCache> {
    return parseAuth(this.cipher.decrypt(await fs.readFile(this.vault(id))))
      .auth;
  }
  async put(id: string, auth: AuthCache) {
    await atomicWrite(
      this.vault(id),
      this.cipher.encrypt(JSON.stringify(auth)),
    );
  }
  private async stage(id: string, home: string) {
    await Rpc.assertHomeIdle(home);
    let auth = await this.auth(id);
    // A crash may happen after Codex rotates its refresh token and before the
    // encrypted vault is updated. Recover the owned, newer file before staging.
    try {
      const pending = parseAuth(
        await fs.readFile(path.join(home, "auth.json"), "utf8"),
      ).auth;
      if (pending.tokens.account_id !== auth.tokens.account_id)
        throw new Error("残留凭据与账户身份不匹配");
      if (
        Date.parse(pending.last_refresh ?? "") >=
        Date.parse(auth.last_refresh ?? "1970-01-01")
      ) {
        auth = pending;
        await this.put(id, auth);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicWrite(path.join(home, "auth.json"), JSON.stringify(auth));
  }
  async refreshTokens(id: string): Promise<AuthCache> {
    if (this.busy.has(id)) throw new Error("客户端负责刷新该账户");
    return this.serial(id, async () => {
      const home = this.store.profileHome(id);
      await this.stage(id, home);
      let rpc: Rpc | undefined;
      try {
        rpc = await Rpc.open(this.store.data.settings.cliPath, home);
        const result = await rpc.call(
          "account/read",
          { refreshToken: true },
          8000,
        );
        if (result.account?.type !== "chatgpt")
          throw new Error("Please sign in");
        await rpc.close();
        rpc = undefined;
        const fresh = parseAuth(
          await fs.readFile(path.join(home, "auth.json"), "utf8"),
        ).auth;
        if (
          fresh.tokens.account_id !==
          this.store.data.accounts.find((a) => a.id === id)?.identity
        )
          throw new Error("刷新后账户身份不匹配");
        await this.put(id, fresh);
        await fs.rm(path.join(home, "auth.json"), { force: true });
        return fresh;
      } finally {
        if (rpc) await rpc.close();
      }
    });
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.locks.set(id, next);
    return next;
  }
  async import(text: string, label?: string): Promise<Account> {
    const parsed = parseAuth(text);
    let account = this.store.data.accounts.find(
      (a) => a.identity === parsed.identity,
    );
    if (account && this.busy.has(account.id))
      throw new Error("该账户正在执行任务；暂停后再更新凭据");
    if (!account) {
      account = {
        id: randomUUID(),
        identity: parsed.identity,
        email: parsed.email,
        plan: parsed.plan,
        label: label || parsed.email,
        enabled: true,
        status: "unknown",
        quotas: {},
        blockedUntil: null,
        failureCount: 0,
      };
      await this.put(account.id, parsed.auth);
      this.store.data.accounts.push(account);
    } else {
      await this.serial(account.id, () => this.put(account!.id, parsed.auth));
      Object.assign(account, {
        email: parsed.email,
        plan: parsed.plan,
        status: "unknown",
        quotas: {},
        blockedUntil: null,
        failureCount: 0,
        lastError: undefined,
      });
      if (label) account.label = label;
    }
    await this.store.save();
    this.changed();
    return account;
  }
  // One refresh-token authority per account. Runtime workers receive external access tokens.
  async inspect(
    id: string,
    forceRefresh = false,
  ): Promise<{
    auth: AuthCache;
    quotas: Record<string, Quota>;
    models: any[];
  }> {
    if (this.busy.has(id))
      throw new Error("客户端正在使用该账户，监控改由客户端凭据执行");
    return this.serial(id, async () => {
      const account = this.store.data.accounts.find((a) => a.id === id);
      if (!account) throw new Error("账户不存在");
      const home = this.store.profileHome(id);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await this.stage(id, home);
      let rpc: Rpc | undefined;
      try {
        rpc = await Rpc.open(this.store.data.settings.cliPath, home);
        const read = await rpc.call("account/read", {
          refreshToken: forceRefresh,
        });
        if (read.account?.type !== "chatgpt")
          throw new Error("Please sign in: ChatGPT account unavailable");
        account.email = read.account.email ?? account.email;
        account.plan = read.account.planType ?? account.plan;
        const raw = await rpc.call("account/rateLimits/read");
        const quotas = parseQuotas(raw);
        if (!Object.keys(quotas).length)
          throw new Error("服务器没有返回订阅额度，保持未知状态");
        const models: any[] = [];
        let cursor: string | null = null;
        if (forceRefresh)
          do {
            const page: any = await rpc.call("model/list", {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            models.push(...(page.data ?? []));
            cursor = page.nextCursor ?? null;
          } while (cursor && models.length < 1000);
        account.quotas = quotas;
        account.status = Object.values(quotas).some(isExhausted)
          ? "limited"
          : "ready";
        account.failureCount = 0;
        account.lastError = undefined;
        if ((account.blockedUntil ?? 0) <= Date.now())
          account.blockedUntil = null;
        await rpc.close();
        rpc = undefined;
        const auth = parseAuth(
          await fs.readFile(path.join(home, "auth.json"), "utf8"),
        ).auth;
        if (auth.tokens.account_id !== account.identity)
          throw new Error("凭据身份不匹配，拒绝写回");
        return { auth, quotas, models };
      } catch (error) {
        const kind = errorKind(error);
        account.status = kind === "auth" ? "reauth" : "offline";
        account.failureCount++;
        account.lastError = redact(
          error instanceof Error ? error.message : error,
        );
        account.blockedUntil =
          Date.now() +
          Math.min(300_000, 15_000 * 2 ** Math.min(account.failureCount, 4));
        throw error;
      } finally {
        if (rpc) await rpc.close();
        // Never remove a rotated refresh token until its encrypted write succeeds.
        const latest = parseAuth(
          await fs.readFile(path.join(home, "auth.json"), "utf8"),
        ).auth;
        if (latest.tokens.account_id !== account.identity)
          throw new Error("凭据身份变化，保留原始文件等待检查");
        await this.put(id, latest);
        await fs.rm(path.join(home, "auth.json"), { force: true });
        await this.store.save();
        this.changed();
      }
    });
  }
  async beginLogin(label: string, device: boolean) {
    await this.cancelLogin();
    this.loginError = undefined;
    const id = randomUUID();
    const home = this.store.profileHome(id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const rpc = await Rpc.open(this.store.data.settings.cliPath, home);
    let early: any;
    const finish = (event: any) =>
      void this.finishLogin(event, label).catch((error) => {
        this.loginDisplay = undefined;
        this.loginError = redact(error);
        this.changed();
      });
    rpc.on("account/login/completed", (event: any) => {
      if (this.login?.rpc !== rpc) {
        early = event;
        return;
      }
      finish(event);
    });
    try {
      const result = await rpc.call("account/login/start", {
        type: device ? "chatgptDeviceCode" : "chatgpt",
      });
      this.login = {
        id,
        rpc,
        loginId: result.loginId,
        timer: setTimeout(
          () => void this.cancelLogin().catch(() => {}),
          15 * 60_000,
        ),
      };
      this.loginDisplay = {
        accountId: id,
        url: result.authUrl ?? result.verificationUrl,
        code: result.userCode,
      };
      const display = this.loginDisplay;
      this.changed();
      if (early) finish(early);
      return display;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
  private async finishLogin(event: any, label: string) {
    const login = this.login;
    if (!login) return;
    clearTimeout(login.timer);
    this.login = undefined;
    this.loginDisplay = undefined;
    try {
      if (!event.success) throw new Error(event.error ?? "登录未完成");
      await login.rpc.close();
      const account = await this.import(
        await fs.readFile(
          path.join(this.store.profileHome(login.id), "auth.json"),
          "utf8",
        ),
        label,
      );
      await this.inspect(account.id).catch(() => {});
    } finally {
      await login.rpc.close();
      await fs.rm(this.store.profileHome(login.id), {
        recursive: true,
        force: true,
      });
      this.changed();
    }
  }
  async cancelLogin() {
    const login = this.login;
    this.login = undefined;
    this.loginDisplay = undefined;
    if (login) {
      clearTimeout(login.timer);
      await login.rpc
        .call("account/login/cancel", { loginId: login.loginId })
        .catch(() => {});
      await login.rpc.close();
      await fs.rm(this.store.profileHome(login.id), {
        recursive: true,
        force: true,
      });
    }
    this.changed();
  }
  async remove(id: string) {
    if (this.busy.has(id)) throw new Error("该账户正在使用");
    await this.serial(id, async () => {
      await fs.rm(this.vault(id), { force: true });
      await fs.rm(this.store.profileHome(id), { recursive: true, force: true });
      this.store.data.accounts = this.store.data.accounts.filter(
        (a) => a.id !== id,
      );
      await this.store.save();
      this.changed();
    });
  }
}
