import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopWorker } from "../src/core/desktop-worker";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { Cdp } from "../src/core/cdp";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/windows-sandbox", () => ({
  ensureWindowsSandbox: vi.fn(async () => {}),
}));
let root: string,
  worker: any,
  store: Store,
  job: Job,
  bootstrap: any,
  cdp: any,
  accounts: any,
  transcript: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-start-"));
  store = new Store(root);
  job = {
    id: "job-123456",
    title: "合成测试",
    prompt: "原始目标",
    cwd: root,
    mode: "desktop",
    model: "",
    effort: "",
    bucket: "codex",
    state: "preparing",
    rotations: 0,
    createdAt: 0,
    updatedAt: 0,
    accountId: "account",
    sandbox: "workspaceWrite",
    approvalPolicy: "on-request",
  };
  const auth = {
    tokens: {
      id_token: "synthetic",
      access_token: "synthetic",
      account_id: "identity",
    },
  };
  store.data.accounts = [{ id: "account", identity: "identity" } as any];
  store.data.jobs = [job];
  transcript = path.join(root, "sessions", "rollout-thread-123.jsonl");
  await fs.mkdir(path.dirname(transcript));
  // Old success must be ignored: the worker starts tailing from the current end.
  await fs.writeFile(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } }) +
      "\n" +
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old",
          last_agent_message: "old success",
        },
      }) +
      "\n",
  );
  bootstrap = Object.assign(new EventEmitter(), {
    call: vi.fn(async (method: string) =>
      method.startsWith("thread/")
        ? { thread: { id: "thread-123" }, model: "selected-model" }
        : {},
    ),
    close: vi.fn(async () => {}),
  });
  vi.spyOn(Rpc, "open").mockResolvedValue(bootstrap);
  cdp = {
    close: vi.fn(),
    call: vi.fn(async () => ({})),
    selectThread: vi.fn(async () => true),
    isThreadSelected: vi.fn(async () => true),
    fill: vi.fn(async () => {}),
    clickForThread: vi.fn(async () => {
      const persisted = JSON.parse(
        await fs.readFile(path.join(root, "state.json"), "utf8"),
      );
      expect(persisted.jobs[0].desktopSubmissionPending).toBe(true);
      await fs.appendFile(
        transcript,
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started", turn_id: "new-turn" },
        }) + "\n",
      );
      return true;
    }),
  };
  vi.spyOn(Cdp, "connect").mockResolvedValue(cdp);
  accounts = {
    busy: new Set(),
    acquireDesktop: vi.fn(async () => {
      accounts.busy.add("account");
      return auth;
    }),
    put: vi.fn(async () => {}),
  };
  worker = new DesktopWorker(
    {
      job,
      home: root,
      cli: "synthetic",
      resumePrompt: "继续并先检查已有结果",
      shouldStart: () => true,
      checkpoint: async (t, u) => {
        job.threadId = t;
        if (u) job.turnId = u;
        await store.save();
      },
      refresh: vi.fn(),
    },
    store,
    accounts,
    "/unused",
  );
  worker.powershell = vi.fn(async (script: string, args: string[]) => {
    if (script === "desktop-launch.ps1") {
      const request = JSON.parse(await fs.readFile(args[1], "utf8"));
      expect(
        await fs.readFile(path.join(root, "config.toml"), "utf8"),
      ).toContain('model = "selected-model"');
      expect(bootstrap.close).toHaveBeenCalledOnce();
      await fs.writeFile(
        request.receipt,
        JSON.stringify({ nonce: request.nonce, started: true, pid: 123 }),
      );
      await fs.writeFile(
        path.join(request.userData, "DevToolsActivePort"),
        "12345\n",
      );
    }
    return { stdout: '{"running":true}' };
  });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});
afterEach(async () => {
  try {
    await worker.close();
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("prepares a durable thread, pins model before desktop launch and waits for the new turn", async () => {
  const finished = vi.fn();
  worker.done.then(finished);
  await worker.start({
    accessToken: "synthetic",
    chatgptAccountId: "identity",
    chatgptPlanType: "plus",
  });
  expect(job.threadId).toBe("thread-123");
  expect(job.turnId).toBe("new-turn");
  expect(job.desktopSubmissionPending).toBe(false);
  expect(cdp.fill).toHaveBeenCalledWith(expect.any(String), "原始目标");
  expect(finished).not.toHaveBeenCalled();
  expect(bootstrap.call.mock.calls.map((c: any) => c[0])).toEqual([
    "account/login/start",
    "thread/start",
    "thread/archive",
    "thread/unarchive",
    "thread/resume",
    "thread/name/set",
  ]);
  expect(bootstrap.call).toHaveBeenCalledWith(
    "thread/resume",
    expect.objectContaining({ config: { "features.goals": false } }),
  );
  await worker.close();
  expect(accounts.put).toHaveBeenCalledOnce();
  expect(accounts.busy.size).toBe(0);
  await expect(fs.access(path.join(root, "auth.json"))).rejects.toThrow();
});
it("stops preparation before any desktop launch when pause arrives during bootstrap", async () => {
  let entered!: () => void, reject!: (e: Error) => void;
  const gate = new Promise<void>((r) => {
    entered = r;
  });
  bootstrap.call.mockImplementation(async (method: string) => {
    if (method === "thread/start") {
      entered();
      return new Promise((_, r) => {
        reject = r;
      });
    }
    return {};
  });
  bootstrap.close.mockImplementation(async () =>
    reject(new Error("bootstrap stopped")),
  );
  const result = worker
    .start({
      accessToken: "synthetic",
      chatgptAccountId: "identity",
      chatgptPlanType: "plus",
    })
    .catch((e: any) => e);
  await gate;
  await worker.stop();
  expect(await result).toBeInstanceOf(Error);
  expect(worker.powershell).not.toHaveBeenCalled();
  expect(cdp.clickForThread).not.toHaveBeenCalled();
});
