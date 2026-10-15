import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Accounts } from "../src/core/accounts";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { ProcessSafetyError } from "../src/core/process-safety-error";
vi.mock("../src/core/rpc", () => ({
  Rpc: { open: vi.fn(), assertHomeIdle: vi.fn(async () => {}) },
}));
const auth = (access = "old") => ({
  tokens: {
    id_token: "synthetic",
    access_token: access,
    refresh_token: "synthetic-refresh",
    account_id: "identity",
  },
  last_refresh: "2026-01-01T00:00:00Z",
});
const quota = () => ({
  rateLimits: {
    limitId: "codex",
    primary: {
      usedPercent: 10,
      windowDurationMins: 300,
      resetsAt: Date.now() / 1000 + 1000,
    },
    secondary: null,
  },
});
class FakeRpc extends EventEmitter {
  call = vi.fn(async (method: string): Promise<any> => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/rateLimits/read") return quota();
    if (method === "model/list") return { data: [] };
    if (method === "account/login/start")
      return { loginId: "login", authUrl: "https://auth.openai.com/synthetic" };
    return {};
  });
  close = vi.fn(async () => {});
}
let root: string, store: Store, accounts: Accounts, rpc: FakeRpc;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-"));
  store = new Store(root);
  accounts = new Accounts(
    store,
    { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    () => {},
  );
  rpc = new FakeRpc();
  vi.mocked(Rpc.open).mockResolvedValue(rpc as any);
});
afterEach(async () => {
  await accounts.cancelLogin();
  await accounts.drain();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe("single refresh-token authority", () => {
  it("deduplicates simultaneous imports of the same identity", async () => {
    const [a, b] = await Promise.all([
      accounts.import(JSON.stringify(auth())),
      accounts.import(JSON.stringify(auth())),
    ]);
    expect(a.id).toBe(b.id);
    expect(store.data.accounts).toHaveLength(1);
  });
  it("rechecks exclusivity after queued work acquires its account lock", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    const lease = accounts.acquireDesktop(a.id);
    const inspected = accounts.inspect(a.id).catch((e) => e);
    await lease;
    expect(await inspected).toBeInstanceOf(Error);
    expect(Rpc.open).not.toHaveBeenCalled();
    expect(accounts.busy.has(a.id)).toBe(true);
  });
  it("cannot delete a credential while an earlier desktop lease is being acquired", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    const lease = accounts.acquireDesktop(a.id);
    const removed = accounts.remove(a.id).catch((e) => e);
    await lease;
    expect(await removed).toBeInstanceOf(Error);
    expect((await accounts.auth(a.id)).tokens.access_token).toBe("old");
  });
  it("recovers an undated rotated cache instead of overwriting it with the old vault", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    const home = store.profileHome(a.id);
    await fs.mkdir(home, { recursive: true });
    const pending: any = auth("fresh");
    delete pending.last_refresh;
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(pending));
    expect((await accounts.acquireDesktop(a.id)).tokens.access_token).toBe(
      "fresh",
    );
  });
  it("explicit new login supersedes abandoned credentials even with a later timestamp", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    const home = store.profileHome(a.id);
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ ...auth("abandoned"), last_refresh: "2099-01-01" }),
    );
    await accounts.import(JSON.stringify(auth("new-login")));
    expect((await accounts.acquireDesktop(a.id)).tokens.access_token).toBe(
      "new-login",
    );
  });
  it("keeps staged credentials if encrypted persistence fails", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    vi.spyOn(accounts, "put").mockRejectedValue(new Error("disk full"));
    await expect(accounts.inspect(a.id)).rejects.toThrow("disk full");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(store.profileHome(a.id), "auth.json"),
          "utf8",
        ),
      ).tokens.access_token,
    ).toBe("old");
  });
  it("keeps successfully logged-in tokens when importing them into the vault fails", async () => {
    const display = await accounts.beginLogin("test", false);
    const file = path.join(store.profileHome(display.accountId), "auth.json");
    await fs.writeFile(file, JSON.stringify(auth("new-login")));
    vi.spyOn(accounts, "put").mockRejectedValue(new Error("vault unavailable"));
    rpc.emit("account/login/completed", { loginId: "login", success: true });
    await accounts.drain();
    expect(await fs.readFile(file, "utf8")).toContain("new-login");
    expect(accounts.loginError).toContain("vault unavailable");
  });
  it("a fresh positive server observation clears the previous quota cooldown", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    a.blockedUntil = Date.now() + 7 * 86400000;
    await accounts.inspect(a.id);
    expect(a.blockedUntil).toBeNull();
  });
  it("leaves credentials in place when initialization cleanup cannot confirm process exit", async () => {
    const a = await accounts.import(JSON.stringify(auth()));
    vi.mocked(Rpc.open).mockRejectedValueOnce(
      new ProcessSafetyError("process still alive", new Error("stop failed")),
    );
    await expect(accounts.inspect(a.id)).rejects.toBeInstanceOf(
      ProcessSafetyError,
    );
    expect(
      await fs.readFile(
        path.join(store.profileHome(a.id), "auth.json"),
        "utf8",
      ),
    ).toContain("synthetic-refresh");
  });
});

it("blocks reimporting an account used by a running CLI task", async () => {
  const account = await accounts.import(JSON.stringify(auth()));
  store.data.jobs = [
    { accountId: account.id, state: "running", mode: "cli" } as any,
  ];
  await expect(
    accounts.import(JSON.stringify(auth("replacement"))),
  ).rejects.toThrow("正在执行任务");
  expect((await accounts.auth(account.id)).tokens.access_token).toBe("old");
});
