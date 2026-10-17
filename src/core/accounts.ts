import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, Quota, ModelAccess } from "../shared/types";
import { modelAccess } from "../shared/model-access";
import { Store, atomicWrite } from "./store";
import { Rpc } from "./rpc";
import { errorKind, hasQuotaEvidence, isExhausted, parseQuotas } from "./quota";
import { redact } from "./redact";
import { ProcessSafetyError } from "./process-safety-error";
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
    const value = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
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
  let auth: any;
  try {
    auth = JSON.parse(text);
  } catch {
    throw new Error("认证文件不是有效 JSON");
  }
  if (!auth || typeof auth !== "object" || Array.isArray(auth))
    throw new Error("认证文件必须为对象");
  if (
    auth.OPENAI_API_KEY ||
    auth.api_key ||
    (auth.auth_mode &&
      !["chatgpt", "chatgptAuthTokens"].includes(auth.auth_mode)) ||
    typeof auth.tokens?.access_token !== "string" ||
    !auth.tokens.access_token ||
    typeof auth.tokens?.id_token !== "string" ||
    (auth.tokens?.refresh_token !== undefined &&
      typeof auth.tokens.refresh_token !== "string")
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
  auth.auth_mode = "chatgpt";
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
  quotaObserved?: (
    account: Account,
    previous: Record<string, Quota>,
    fresh: Record<string, Quota>,
  ) => void;
  private locks = new Map<string, Promise<unknown>>();
  private login?: {
    id: string;
    rpc: Rpc;
    loginId: string;
    timer: NodeJS.Timeout;
  };
  loginDisplay?: { accountId: string; url: string; code?: string };
  loginError?: string;
  loginResult?: { accountId: string; email: string; updated: boolean };
  busy = new Set<string>();
  constructor(
    private store: Store,
    private cipher: Cipher,
    private changed: () => void,
  ) {}
  private available(id: string) {
    if (this.busy.has(id)) throw new Error("该账户由客户端独占，暂停后再操作");
    if (!this.store.data.accounts.some((a) => a.id === id))
      throw new Error("账户不存在");
  }
  private assertExternalRefreshIdle() {
    if (
      this.store.data.jobs.some(
        (j) =>
          j.existing &&
          j.existing.phase !== "managed" &&
          !["completed", "cancelled"].includes(j.state),
      )
    )
      throw new Error(
        "原 Codex 实例仍负责登录刷新；请先交接或取消接入，再手动刷新账户",
      );
  }
  async drain() {
    for (;;) {
      const pending = [...this.locks.values()];
      await Promise.allSettled(pending);
      if ([...this.locks.values()].every((p) => pending.includes(p))) return;
    }
  }
  async acquireDesktop(id: string): Promise<AuthCache> {
    return this.serial(id, async () => {
      this.available(id);
      const home = this.store.profileHome(id);
      await this.stage(id, home);
      const auth = parseAuth(
        await fs.readFile(path.join(home, "auth.json"), "utf8"),
      ).auth;
      await this.put(id, auth);
      await fs.rm(path.join(home, "auth.json"), { force: true });
      this.busy.add(id);
      return auth;
    });
  }
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
        !Number.isFinite(Date.parse(pending.last_refresh ?? "")) ||
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
    this.assertExternalRefreshIdle();
    if (this.busy.has(id)) throw new Error("客户端负责刷新该账户");
    return this.serial(id, async () => {
      this.assertExternalRefreshIdle();
      this.available(id);
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
        this.store.data.accounts.find((a) => a.id === id)!.modelAccess =
          undefined;
        this.store.data.accounts.find((a) => a.id === id)!.modelDenials =
          undefined;
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
    const release = () => {
      if (this.locks.get(id) === next) this.locks.delete(id);
    };
    void next.then(release, release);
    return next;
  }
  import(text: string, label?: string): Promise<Account> {
    const parsed = parseAuth(text);
    return this.serial(`identity:${parsed.identity}`, () =>
      this.importOnce(parsed, label),
    );
  }
  private async importOnce(
    parsed: ReturnType<typeof parseAuth>,
    label?: string,
  ): Promise<Account> {
    let account = this.store.data.accounts.find(
      (a) => a.identity === parsed.identity,
    );
    if (
      account &&
      (this.busy.has(account.id) ||
        this.store.data.jobs.some(
          (job) =>
            job.accountId === account!.id &&
            (job.recoveryRequired ||
              ["preparing", "running", "pausing", "rotating"].includes(
                job.state,
              )),
        ))
    )
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
        modelAccess: undefined,
        modelDenials: undefined,
      };
      await this.put(account.id, parsed.auth);
      this.store.data.accounts.push(account);
    } else {
      await this.serial(account.id, async () => {
        this.available(account!.id);
        if (
          this.store.data.jobs.some(
            (job) =>
              job.accountId === account!.id &&
              (job.recoveryRequired ||
                ["preparing", "running", "pausing", "rotating"].includes(
                  job.state,
                )),
          )
        )
          throw new Error("请先暂停使用此账户的任务，再更新凭据");
        const home = this.store.profileHome(account!.id);
        await Rpc.assertHomeIdle(home);
        await this.put(account!.id, parsed.auth);
        // An explicit new login supersedes an old, abandoned refresh cache.
        await fs.rm(path.join(home, "auth.json"), { force: true });
      });
      Object.assign(account, {
        email: parsed.email,
        plan: parsed.plan,
        status: "unknown",
        quotas: {},
        blockedUntil: null,
        failureCount: 0,
        lastError: undefined,
        modelAccess: undefined,
        modelDenials: undefined,
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
    modelAccess?: ModelAccess;
  }> {
    this.assertExternalRefreshIdle();
    if (this.busy.has(id))
      throw new Error("客户端正在使用该账户，监控改由客户端凭据执行");
    return this.serial(id, async () => {
      this.assertExternalRefreshIdle();
      this.available(id);
      const account = this.store.data.accounts.find((a) => a.id === id);
      if (!account) throw new Error("账户不存在");
      const home = this.store.profileHome(id);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await this.stage(id, home);
      let rpc: Rpc | undefined;
      let processUncertain = false;
      try {
        rpc = await Rpc.open(this.store.data.settings.cliPath, home);
        const read = await rpc.call("account/read", {
          refreshToken: forceRefresh,
        });
        if (read.account?.type !== "chatgpt")
          throw new Error("Please sign in: ChatGPT account unavailable");
        account.email = read.account.email ?? account.email;
        if (read.account.planType && read.account.planType !== account.plan) {
          account.modelAccess = undefined;
          account.modelDenials = undefined;
        }
        account.plan = read.account.planType ?? account.plan;
        const raw = await rpc.call("account/rateLimits/read");
        const quotas = parseQuotas(raw);
        if (!Object.keys(quotas).length)
          throw new Error("服务器没有返回订阅额度，保持未知状态");
        const models: any[] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let complete = false;
        if (forceRefresh)
          do {
            const page: any = await rpc.call("model/list", {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            if (!Array.isArray(page.data))
              throw Error("模型目录格式无效，请稍后重试");
            models.push(...page.data);
            cursor = page.nextCursor ?? null;
            complete = !cursor;
            if (cursor && cursors.has(cursor)) break;
            if (cursor) cursors.add(cursor);
          } while (cursor && models.length < 1000);
        const previous = account.quotas;
        account.quotas = quotas;
        account.status = Object.values(quotas).some(isExhausted)
          ? "limited"
          : Object.values(quotas).some(hasQuotaEvidence)
            ? "ready"
            : "unknown";
        account.failureCount = 0;
        account.lastError = undefined;
        if (
          (account.blockedUntil ?? 0) <= Date.now() ||
          account.status === "ready"
        )
          account.blockedUntil = null;
        await rpc.close();
        rpc = undefined;
        const auth = parseAuth(
          await fs.readFile(path.join(home, "auth.json"), "utf8"),
        ).auth;
        if (auth.tokens.account_id !== account.identity)
          throw new Error("凭据身份不匹配，拒绝写回");
        if (forceRefresh)
          account.modelAccess = modelAccess(models, Date.now(), complete);
        this.quotaObserved?.(account, previous, quotas);
        return { auth, quotas, models, modelAccess: account.modelAccess };
      } catch (error) {
        processUncertain = error instanceof ProcessSafetyError;
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
        if (!processUncertain) {
          // Never remove a rotated refresh token until its encrypted write succeeds.
          const latest = parseAuth(
            await fs.readFile(path.join(home, "auth.json"), "utf8"),
          ).auth;
          if (latest.tokens.account_id !== account.identity)
            throw new Error("凭据身份变化，保留原始文件等待检查");
          await this.put(id, latest);
          await fs.rm(path.join(home, "auth.json"), { force: true });
        }
        await this.store.save();
        this.changed();
      }
    });
  }
  beginLogin(label: string, device: boolean) {
    return this.serial("$login", () => this.beginLoginOnce(label, device));
  }
  private async beginLoginOnce(label: string, device: boolean) {
    await this.cancelLoginOnce();
    this.loginError = undefined;
    this.loginResult = undefined;
    const id = randomUUID();
    const home = this.store.profileHome(id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const rpc = await Rpc.open(this.store.data.settings.cliPath, home);
    let early: any;
    const finish = (event: any) =>
      void this.serial("$login", () =>
        this.finishLogin(event, label, rpc),
      ).catch((error) => {
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
          () =>
            void this.serial("$login", () => this.cancelLoginOnce(rpc)).catch(
              () => {},
            ),
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
  private async finishLogin(event: any, label: string, rpc: Rpc) {
    const login = this.login;
    if (
      !login ||
      login.rpc !== rpc ||
      (event.loginId && event.loginId !== login.loginId)
    )
      return;
    let imported = false;
    clearTimeout(login.timer);
    this.login = undefined;
    this.loginDisplay = undefined;
    try {
      if (!event.success) throw new Error(event.error ?? "登录未完成");
      await login.rpc.close();
      const text = await fs.readFile(
        path.join(this.store.profileHome(login.id), "auth.json"),
        "utf8",
      );
      const identity = parseAuth(text).identity;
      const updated = this.store.data.accounts.some(
        (a) => a.identity === identity,
      );
      const account = await this.import(text, label);
      imported = true;
      this.loginResult = {
        accountId: account.id,
        email: account.email,
        updated,
      };
      this.changed();
      await this.inspect(account.id).catch(() => {});
    } finally {
      await login.rpc.close();
      if (imported || !event.success)
        await fs.rm(this.store.profileHome(login.id), {
          recursive: true,
          force: true,
        });
      this.changed();
    }
  }
  cancelLogin() {
    return this.serial("$login", () => this.cancelLoginOnce());
  }
  private async cancelLoginOnce(expected?: Rpc) {
    const login = this.login;
    if (expected && login?.rpc !== expected) return;
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
      this.available(id);
      await Rpc.assertHomeIdle(this.store.profileHome(id));
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
