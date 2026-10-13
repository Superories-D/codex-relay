import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { Store } from "../src/core/store";
import { Scheduler } from "../src/core/scheduler";
import { CliWorker } from "../src/core/cli-worker";
vi.mock("../src/core/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/process")>();
  return {
    ...actual,
    spawnCodex: async (_cli: string, _args: string[], home: string) =>
      spawn(
        process.execPath,
        [path.join(process.cwd(), "tests/fixtures/app-server.cjs")],
        {
          env: { ...process.env, RELAY_TEST_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
  };
});
it("real JSONL child processes rotate on error and resume the same persisted thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-integration-"));
  const store = new Store(root);
  store.data.accounts = ["a", "b"].map((id) => ({
    id,
    identity: id,
    label: id,
    email: id,
    plan: "test",
    enabled: true,
    status: "ready",
    blockedUntil: null,
    failureCount: 0,
    quotas: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: Date.now() + 1000000,
        },
        secondary: null,
        observedAt: Date.now(),
        reached: false,
      },
    },
  }));
  const accounts: any = {
    busy: new Set(),
    inspect: async (id: string) => ({
      auth: { tokens: { access_token: "synthetic" } },
      models: [],
      quotas: store.data.accounts.find((a) => a.id === id)!.quotas,
    }),
    cancelLogin: async () => {},
  };
  const scheduler = new Scheduler(store, accounts, {
    cli: (ctx) => new CliWorker(ctx),
    desktop: () => {
      throw Error("not used");
    },
  });
  try {
    const job = await scheduler.add({
      title: "test",
      prompt: "Original goal",
      cwd: root,
      mode: "cli",
      model: "",
      effort: "",
      bucket: "codex",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    });
    await vi.waitFor(() => expect(job.rotations).toBe(1), {
      timeout: 5000,
      interval: 10,
    });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("queued");
    expect(job.threadId).toBe("synthetic-thread");
    await (scheduler as any).tick();
    await vi.waitFor(() => expect(job.state).toBe("completed"), {
      timeout: 5000,
      interval: 10,
    });
    await (scheduler as any).currentRun;
    const journal = (
      await fs.readFile(
        path.join(store.jobHome(job.id), "synthetic-journal.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(journal.map((j) => j.account)).toEqual(["a", "b"]);
    expect(journal.map((j) => j.threadId)).toEqual([
      "synthetic-thread",
      "synthetic-thread",
    ]);
    expect(journal[0].input).toBe("Original goal");
    expect(journal[1].input).toBe(store.data.settings.resumePrompt);
    await expect(
      fs.stat(path.join(store.jobHome(job.id), "relay-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await scheduler.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);
