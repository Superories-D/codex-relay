import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Accounts, parseAuth } from "../src/core/accounts";
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
const teamAuth = (user: string, workspace = "shared-team") => {
  const value = auth(user);
  value.tokens.account_id = workspace;
  value.tokens.id_token =
    "e30." +
    Buffer.from(
      JSON.stringify({
        sub: user,
        email: `${user}@example.test`,
        "https://api.openai.com/auth": {
          chatgpt_account_id: workspace,
          chatgpt_plan_type: "team",
        },
      }),
    ).toString("base64url") +
    ".synthetic";
  return value;
};
it("keeps distinct users in the same Team separate, migrates legacy vault metadata, and updates only the exact user/workspace", async () => {
  const first = await accounts.import(JSON.stringify(teamAuth("one")));
  delete first.userIdentity;
  const second = await accounts.import(JSON.stringify(teamAuth("two")));
  const third = await accounts.import(JSON.stringify(teamAuth("three")));
  expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  expect(first.userIdentity).toBe("one");
  expect(first.identity).toBe("shared-team");
  expect(
    parseAuth(JSON.stringify(await accounts.auth(first.id))).userIdentity,
  ).toBe("one");
  const updated = await accounts.import(JSON.stringify(teamAuth("two")));
  expect(updated.id).toBe(second.id);
  expect(store.data.accounts).toHaveLength(3);
  const personal = await accounts.import(
    JSON.stringify(teamAuth("two", "personal")),
  );
  expect(personal.id).not.toBe(second.id);
});
it("refuses a staged cache belonging to a different user in the same Team without overwriting the vault", async () => {
  const first = await accounts.import(JSON.stringify(teamAuth("one")));
  const home = store.profileHome(first.id);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "auth.json"),
    JSON.stringify(teamAuth("two")),
  );
  await expect(accounts.inspect(first.id)).rejects.toThrow("身份");
  expect(
    parseAuth(JSON.stringify(await accounts.auth(first.id))).userIdentity,
  ).toBe("one");
  expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toContain(
    "two",
  );
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
it("persists all model pages and aliases without treating a model introduction as denial", async () => {
  const a = await accounts.import(JSON.stringify(auth()));
  const original = rpc.call.getMockImplementation()!;
  let page = 0;
  rpc.call.mockImplementation(async (method) =>
    method === "model/list"
      ? ++page === 1
        ? {
            data: [
              {
                id: "alias",
                model: "engine",
                availabilityNux: { message: "Try it" },
              },
            ],
            nextCursor: "second",
          }
        : { data: [{ id: "another" }], nextCursor: null }
      : original(method),
  );
  const result = await accounts.inspect(a.id, true);
  expect(result.modelAccess).toMatchObject({
    ids: ["alias", "engine", "another"],
    complete: true,
  });
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.accounts[0].modelAccess).toEqual(result.modelAccess);
});
it("retains partial model evidence when the server repeats its pagination cursor", async () => {
  const a = await accounts.import(JSON.stringify(auth()));
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method) =>
    method === "model/list"
      ? { data: [{ id: "listed" }], nextCursor: "repeated" }
      : original(method),
  );
  const result = await accounts.inspect(a.id, true);
  expect(result.modelAccess).toMatchObject({
    ids: ["listed"],
    complete: false,
  });
  expect(rpc.call.mock.calls.filter(([m]) => m === "model/list")).toHaveLength(
    2,
  );
});
it("invalidates old model routing and rejection evidence when credentials are explicitly reimported", async () => {
  const a = await accounts.import(JSON.stringify(auth()));
  a.modelAccess = { ids: ["old"], complete: true, observedAt: Date.now() };
  a.modelDenials = { wanted: Date.now() };
  await accounts.import(JSON.stringify(auth("new")));
  expect(a.modelAccess).toBeUndefined();
  expect(a.modelDenials).toBeUndefined();
});
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
  it("shares overlapping worker refreshes and stages the latest credential for the next independent refresh", async () => {
    const account = await accounts.import(JSON.stringify(auth()));
    let active = 0,
      maximum = 0,
      generation = 0;
    const staged: string[] = [];
    vi.mocked(Rpc.open).mockImplementation(async (_cli, home) => {
      active++;
      maximum = Math.max(maximum, active);
      let closed = false;
      return {
        call: async () => {
          staged.push(
            JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"))
              .tokens.access_token,
          );
          await fs.writeFile(
            path.join(home, "auth.json"),
            JSON.stringify(auth(`generation-${++generation}`)),
          );
          return { account: { type: "chatgpt" } };
        },
        close: async () => {
          if (!closed) {
            closed = true;
            active--;
          }
        },
      } as any;
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => accounts.refreshTokens(account.id)),
    );
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(staged).toEqual(["old"]);
    expect(results.map((r) => r.tokens.access_token)).toEqual([
      "generation-1",
      "generation-1",
      "generation-1",
    ]);
    expect((await accounts.refreshTokens(account.id)).tokens.access_token).toBe(
      "generation-2",
    );
    expect(staged).toEqual(["old", "generation-1"]);
    expect((await accounts.auth(account.id)).tokens.access_token).toBe(
      "generation-2",
    );
  });

  it("blocks refresh work queued before an existing instance becomes the token authority", async () => {
    const account = await accounts.import(JSON.stringify(auth()));
    const refreshing = accounts.refreshTokens(account.id).catch((e) => e);
    store.data.jobs.push({
      id: "external",
      state: "watching",
      existing: { phase: "watching" },
    } as any);
    expect(await refreshing).toBeInstanceOf(Error);
    await expect(accounts.inspect(account.id)).rejects.toThrow("原 Codex 实例");
    expect(Rpc.open).not.toHaveBeenCalled();
  });
  it("shares a failed refresh, retains rotated credentials and permits a later retry", async () => {
    const account = await accounts.import(JSON.stringify(auth()));
    vi.mocked(Rpc.open).mockImplementationOnce(
      async (_cli, home) =>
        ({
          call: async () => {
            await fs.writeFile(
              path.join(home, "auth.json"),
              JSON.stringify(auth("rotated-before-error")),
            );
            throw Error("temporary network failure");
          },
          close: async () => {},
        }) as any,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => accounts.refreshTokens(account.id)),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(Rpc.open).toHaveBeenCalledOnce();
    expect((await accounts.auth(account.id)).tokens.access_token).toBe("old");
    const file = path.join(store.profileHome(account.id), "auth.json");
    expect(
      JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token,
    ).toBe("rotated-before-error");
    vi.mocked(Rpc.open).mockImplementationOnce(
      async (_cli, home) =>
        ({
          call: async () => {
            expect(
              JSON.parse(
                await fs.readFile(path.join(home, "auth.json"), "utf8"),
              ).tokens.access_token,
            ).toBe("rotated-before-error");
            return { account: { type: "chatgpt" } };
          },
          close: async () => {},
        }) as any,
    );
    expect((await accounts.refreshTokens(account.id)).tokens.access_token).toBe(
      "rotated-before-error",
    );
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects every refresh waiter with process safety failure without releasing staged credentials", async () => {
    const account = await accounts.import(JSON.stringify(auth()));
    const close = vi.fn(async () => {
      throw Error("still alive");
    });
    vi.mocked(Rpc.open).mockImplementationOnce(
      async (_cli, home) =>
        ({
          call: async () => {
            await fs.writeFile(
              path.join(home, "auth.json"),
              JSON.stringify(auth("rotated-pending-close")),
            );
            return { account: { type: "chatgpt" } };
          },
          close,
        }) as any,
    );
    const results = await Promise.allSettled([
      accounts.refreshTokens(account.id),
      accounts.refreshTokens(account.id),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(ProcessSafetyError);
    }
    expect(Rpc.open).toHaveBeenCalledOnce();
    expect((await accounts.auth(account.id)).tokens.access_token).toBe("old");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(store.profileHome(account.id), "auth.json"),
          "utf8",
        ),
      ).tokens.access_token,
    ).toBe("rotated-pending-close");
  });
  it("refreshes different accounts independently while sharing each account's own request", async () => {
    const a = await accounts.import(JSON.stringify(teamAuth("one")));
    const b = await accounts.import(JSON.stringify(teamAuth("two")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    vi.mocked(Rpc.open).mockImplementation(
      async () =>
        ({
          call: async () => {
            started++;
            await gate;
            return { account: { type: "chatgpt" } };
          },
          close: async () => {},
        }) as any,
    );
    const tasks = [
      accounts.refreshTokens(a.id),
      accounts.refreshTokens(a.id),
      accounts.refreshTokens(b.id),
    ];
    try {
      await vi.waitFor(() => expect(started).toBe(2));
    } finally {
      release();
    }
    const results = await Promise.all(tasks);
    expect(results.map((r) => r.tokens.access_token)).toEqual([
      "one",
      "one",
      "two",
    ]);
    expect(Rpc.open).toHaveBeenCalledTimes(2);
  });

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
  it("adds a distinct third login and clearly reports a browser login reusing an existing identity", async () => {
    for (const identity of ["one", "two"]) {
      const value = auth();
      value.tokens.account_id = identity;
      await accounts.import(JSON.stringify(value));
    }
    const display = await accounts.beginLogin("third", false);
    const value = auth();
    value.tokens.account_id = "three";
    await fs.writeFile(
      path.join(store.profileHome(display.accountId), "auth.json"),
      JSON.stringify(value),
    );
    rpc.emit("account/login/completed", { loginId: "login", success: true });
    await accounts.drain();
    expect(store.data.accounts).toHaveLength(3);
    expect(accounts.loginResult).toMatchObject({ updated: false });
    const again = await accounts.beginLogin("third", false);
    expect(accounts.loginResult).toBeUndefined();
    await fs.writeFile(
      path.join(store.profileHome(again.accountId), "auth.json"),
      JSON.stringify(value),
    );
    rpc.emit("account/login/completed", { loginId: "login", success: true });
    await accounts.drain();
    expect(store.data.accounts).toHaveLength(3);
    expect(accounts.loginResult).toMatchObject({ updated: true });
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
