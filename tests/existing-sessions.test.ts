import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Scheduler } from "../src/core/scheduler";
import { ExistingSessions } from "../src/core/existing-sessions";
import {
  copyStoppedSession,
  foldSession,
  fileStamp,
  readSession,
  scanSessions,
} from "../src/core/existing-reader";
import { prepareThread } from "../src/core/thread";
import { taskPrompt } from "../src/core/completion";
import { sessionAttachSchema, sessionScanSchema } from "../src/main/validation";
const roots: string[] = [];
const event = (type: string, p: any = {}) => ({
  type: "event_msg",
  payload: { type, ...p },
});
const quota = (used = 100) =>
  event("token_count", {
    rate_limits: {
      limit_id: "codex",
      primary: {
        used_percent: used,
        window_minutes: 300,
        resets_at: 2000000000,
      },
    },
  });
const lines = (events: unknown[]) =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-existing-"));
  roots.push(root);
  const home = path.join(root, "original"),
    cwd = path.join(root, "project"),
    id = randomUUID();
  const file = path.join(
    home,
    "sessions",
    "2026",
    "10",
    "15",
    `rollout-2026-10-15T12-00-00-${id}.jsonl`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(cwd);
  const meta = {
    type: "session_meta",
    payload: { id, cwd, source: "cli", originator: "codex_cli_rs" },
  };
  await fs.writeFile(
    file,
    lines([
      meta,
      event("task_started", { turn_id: "first" }),
      event("user_message", { message: "继续完成已有项目" }),
    ]),
  );
  const store = new Store(path.join(root, "relay"));
  store.data.accounts = [
    {
      id: "a",
      identity: "a",
      enabled: true,
      status: "limited",
      quotas: {},
      blockedUntil: Date.now() + 3600000,
    } as any,
  ];
  const accounts = {
    busy: new Set(),
    inspect: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => {
    throw Error("unexpected worker");
  });
  const scheduler = new Scheduler(store, accounts as any, {
    cli: factory,
    desktop: factory,
  });
  const owner = {
    pid: 123,
    startedAt: "1000000",
    executable: "C:\\Codex\\codex.exe",
    title: "",
  };
  const driver = {
    inspect: vi.fn(async () => ({ processes: [owner], canHandoff: true })),
    stop: vi.fn(async () => {}),
  };
  const probe = vi.fn(async () => ({
    codex: {
      primary: {
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: 2000000000,
      },
      secondary: null,
      reached: false,
      observedAt: Date.now(),
      limitId: "codex",
    },
  }));
  const service = new ExistingSessions(store, scheduler, driver, probe);
  const attach = async (strategy: "quota" | "now" = "quota") => {
    const scan = await service.scan(home);
    const candidate = scan.candidates[0];
    await service.inspect(candidate.id);
    return service.attach({
      id: candidate.id,
      mode: "cli",
      strategy,
      allowStop: true,
    });
  };
  return {
    root,
    home,
    cwd,
    id,
    file,
    meta,
    store,
    scheduler,
    driver,
    owner,
    service,
    probe,
    factory,
    attach,
  };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
describe("existing session parsing", () => {
  it("does not let old quota errors or quoted task text poison the latest turn", () => {
    const state = foldSession([
      event("task_started", { turn_id: "old" }),
      quota(),
      event("task_complete", { turn_id: "old" }),
      event("task_started", { turn_id: "new" }),
      event("user_message", {
        message: "Explain HTTP 429 and usage limit exceeded",
      }),
      event("agent_message", {
        message: "Usage limit exceeded is an error example",
        phase: "final_answer",
      }),
    ]);
    expect(state.quota).toBe(false);
    expect(state.terminal).toBe(false);
    expect(state.turnId).toBe("new");
  });
  it("requires matching terminal identity and distinguishes throttling from quota", () => {
    const state = foldSession([
      event("task_started", { turn_id: "new" }),
      event("error", { message: "HTTP 429 service throttling" }),
      event("task_complete", { turn_id: "old" }),
    ]);
    expect(state.quota).toBe(false);
    expect(state.hadError).toBe(true);
    expect(state.terminal).toBe(false);
  });
  it("finds the existing goal, cwd and model without modifying original files", async () => {
    const s = await setup();
    await fs.appendFile(
      s.file,
      lines([
        { type: "turn_context", payload: { model: "test-model", cwd: s.cwd } },
      ]),
    );
    const before = await fs.readFile(s.file);
    const scan = await scanSessions(s.home);
    expect(scan.sessions[0].candidate).toMatchObject({
      threadId: s.id,
      cwd: s.cwd,
      model: "test-model",
      status: "running",
    });
    expect(scan.sessions[0].lastPrompt).toBe("继续完成已有项目");
    expect(await fs.readFile(s.file)).toEqual(before);
  });
  it("rejects symlink escapes and identifies dependent histories", async () => {
    const s = await setup();
    const outside = path.join(s.root, "outside.jsonl");
    await fs.copyFile(s.file, outside);
    const link = path.join(s.home, "sessions", "link.jsonl");
    await fs.symlink(outside, link);
    await expect(readSession(s.home, link)).rejects.toThrow("路径");
    await fs.writeFile(
      s.file,
      lines([
        {
          ...s.meta,
          payload: {
            ...s.meta.payload,
            history_base: { thread_id: randomUUID() },
          },
        },
      ]),
    );
    expect((await readSession(s.home, s.file)).candidate.issue).toContain(
      "依赖",
    );
  });
  it("copies complete UTF-8 records and drops only the final interrupted fragment", async () => {
    const s = await setup();
    await fs.appendFile(s.file, '{"type":"unfinished');
    const before = await fs.readFile(s.file);
    const source = await readSession(s.home, s.file);
    const target = path.join(s.root, "copied.jsonl");
    const copied = await copyStoppedSession(source, target);
    expect(copied.sha256).toHaveLength(64);
    expect(await fs.readFile(target, "utf8")).not.toContain("unfinished");
    expect(await fs.readFile(s.file)).toEqual(before);
  });
  it("rejects corruption in complete middle records and a changed session identity", async () => {
    const s = await setup();
    const source = await readSession(s.home, s.file);
    await fs.appendFile(s.file, "{broken}\n");
    await expect(readSession(s.home, s.file)).rejects.toThrow("损坏");
    source.stamp = fileStamp(await fs.stat(s.file));
    await expect(
      copyStoppedSession(source, path.join(s.root, "copy")),
    ).rejects.toThrow("损坏");
    await fs.writeFile(
      s.file,
      lines([{ ...s.meta, payload: { ...s.meta.payload, id: randomUUID() } }]),
    );
    source.stamp = fileStamp(await fs.stat(s.file));
    await expect(
      copyStoppedSession(source, path.join(s.root, "copy")),
    ).rejects.toThrow("身份");
  });
});
it("retains early quota evidence across large turns and incrementally reads appended UTF-8", async () => {
  const s = await setup();
  await fs.appendFile(
    s.file,
    lines([
      quota(),
      { type: "response_item", payload: { text: "中".repeat(1100000) } },
      event("task_complete", { turn_id: "first", last_agent_message: "done" }),
    ]),
  );
  const old = await readSession(s.home, s.file);
  expect(old.quota).toBe(true);
  expect(old.turnId).toBe("first");
  await fs.appendFile(
    s.file,
    lines([event("task_started", { turn_id: "next" })]),
  );
  const message = Buffer.from(
    lines([event("user_message", { message: "增量中文" })]),
  );
  const split = message.indexOf(Buffer.from("中")) + 1;
  await fs.appendFile(s.file, message.subarray(0, split));
  const partial = await readSession(s.home, s.file);
  expect(partial.quota).toBe(false);
  expect(partial.turnId).toBe("next");
  await fs.appendFile(s.file, message.subarray(split));
  const complete = await readSession(s.home, s.file);
  expect(complete.lastPrompt).toBe("增量中文");
  const target = path.join(s.root, "large-copy");
  await copyStoppedSession(complete, target);
  expect((await fs.readFile(target)).equals(await fs.readFile(s.file))).toBe(
    true,
  );
});
it("refuses to copy a file changed after its last read", async () => {
  const s = await setup(),
    source = await readSession(s.home, s.file);
  await fs.appendFile(
    s.file,
    lines([event("user_message", { message: "new" })]),
  );
  await expect(
    copyStoppedSession(source, path.join(s.root, "stale-copy")),
  ).rejects.toThrow("已改变");
});
it("does not monitor a disappeared original process forever", async () => {
  const s = await setup();
  (s.driver as any).alive = vi.fn(async () => false);
  const job = await s.attach();
  await s.service.tick();
  expect(job.state).toBe("needs_attention");
  expect(job.lastError).toContain("已退出");
  expect(s.driver.stop).not.toHaveBeenCalled();
});
describe("existing process handoff", () => {
  it("monitors a running task without dispatching another worker or stopping it", async () => {
    const s = await setup();
    const job = await s.attach();
    await s.service.tick();
    expect(job.state).toBe("watching");
    expect(s.driver.stop).not.toHaveBeenCalled();
    expect(s.factory).not.toHaveBeenCalled();
  });
  it("gives quota precedence over apparent completion and preserves the thread and cwd", async () => {
    const s = await setup();
    const job = await s.attach();
    await fs.appendFile(
      s.file,
      lines([
        quota(),
        event("task_complete", {
          turn_id: "first",
          last_agent_message: "Done",
        }),
      ]),
    );
    s.driver.stop.mockImplementationOnce(async () => {
      expect(job.existing?.phase).toBe("handoff");
      expect(
        JSON.parse(
          await fs.readFile(path.join(s.store.root, "state.json"), "utf8"),
        ).jobs[0].existing.stopAttempted,
      ).toBe(true);
    });
    await s.service.tick();
    expect(job).toMatchObject({
      state: "queued",
      threadId: s.id,
      cwd: s.cwd,
      existing: { phase: "managed", stopConfirmed: true },
    });
    expect(job.importedRollout).toContain(
      path.join("sessions", "2026", "10", "15"),
    );
    expect(s.driver.stop).toHaveBeenCalledTimes(1);
    expect(s.probe).not.toHaveBeenCalled();
    expect(await fs.readFile(job.importedRollout!, "utf8")).toContain(s.id);
  });
  it("immediate handoff never treats a stop failure as completed or starts a worker", async () => {
    const s = await setup();
    const job = await s.attach("now");
    s.driver.stop.mockRejectedValue(new Error("cannot confirm exit"));
    await s.service.tick();
    expect(job.state).toBe("needs_attention");
    expect(job.existing?.phase).toBe("handoff");
    expect(job.importedRollout).toBeUndefined();
    await expect(s.service.control(job.id, "cancel")).rejects.toThrow(
      "停止确认",
    );
    expect(s.factory).not.toHaveBeenCalled();
  });
  it("refuses an owner replacement and permits cancelling before any stop attempt", async () => {
    const s = await setup();
    const job = await s.attach("now");
    s.driver.inspect.mockResolvedValue({
      processes: [{ ...s.owner, startedAt: "reused" }],
      canHandoff: true,
    });
    await s.service.tick();
    expect(job.state).toBe("needs_attention");
    expect(s.driver.stop).not.toHaveBeenCalled();
    await s.service.control(job.id, "cancel");
    expect(job.state).toBe("cancelled");
  });
  it("requires process scope review and explicit closure authorization", async () => {
    const s = await setup();
    const scan = await s.service.scan(s.home);
    const input = {
      id: scan.candidates[0].id,
      mode: "cli" as const,
      strategy: "quota" as const,
      allowStop: false,
    };
    await expect(s.service.attach(input)).rejects.toThrow("检查原进程");
    await s.service.inspect(input.id);
    await expect(s.service.attach(input)).rejects.toThrow("确认结束");
  });
  it("never lets retrying Attach approve a changed process scope that was not shown", async () => {
    const s = await setup();
    const scan = await s.service.scan(s.home);
    const id = scan.candidates[0].id;
    await s.service.inspect(id);
    s.driver.inspect.mockResolvedValue({
      processes: [{ ...s.owner, pid: 456 }],
      canHandoff: true,
    });
    const input = {
      id,
      mode: "cli" as const,
      strategy: "now" as const,
      allowStop: true,
    };
    await expect(s.service.attach(input)).rejects.toThrow("进程列表已改变");
    await expect(s.service.attach(input)).rejects.toThrow("进程列表已改变");
    expect(s.store.data.jobs).toHaveLength(0);
    await s.service.inspect(id);
    await s.service.attach(input);
    expect(s.store.data.jobs).toHaveLength(1);
  });
  it("retains uncertain termination and probes only after terminal records stabilize", async () => {
    const s = await setup();
    const job = await s.attach();
    await fs.appendFile(
      s.file,
      lines([
        event("task_complete", {
          turn_id: "first",
          last_agent_message: "result",
        }),
      ]),
    );
    await s.service.tick();
    expect(s.probe).not.toHaveBeenCalled();
    s.probe.mockRejectedValueOnce(new Error("network unavailable"));
    await s.service.tick();
    expect(job.state).toBe("needs_attention");
    expect(s.driver.stop).not.toHaveBeenCalled();
  });
  it("recognizes normal completion only after fresh quota verification", async () => {
    const s = await setup();
    const job = await s.attach();
    await fs.appendFile(
      s.file,
      lines([
        event("task_complete", {
          turn_id: "first",
          last_agent_message: "result",
        }),
      ]),
    );
    await s.service.tick();
    await s.service.tick();
    expect(job.state).toBe("completed");
    expect(s.probe).toHaveBeenCalledTimes(1);
    expect(s.driver.stop).not.toHaveBeenCalled();
  });
  it("catches a late quota event arriving during final verification", async () => {
    const s = await setup();
    const job = await s.attach();
    await fs.appendFile(
      s.file,
      lines([
        event("task_complete", {
          turn_id: "first",
          last_agent_message: "result",
        }),
      ]),
    );
    await s.service.tick();
    s.probe.mockImplementationOnce(async () => {
      await fs.appendFile(s.file, lines([quota()]));
      return {} as any;
    });
    await s.service.tick();
    expect(job.existing?.phase).toBe("managed");
    expect(job.state).toBe("queued");
  });
  it("does not restart an already completed historical turn just because monitoring was enabled", async () => {
    const s = await setup();
    await fs.appendFile(
      s.file,
      lines([
        event("task_complete", {
          turn_id: "first",
          last_agent_message: "result",
        }),
      ]),
    );
    const job = await s.attach();
    await s.service.tick();
    expect(job.state).toBe("paused");
    expect(s.driver.stop).not.toHaveBeenCalled();
  });
  it("freezes a handed-off job if the original session is restarted", async () => {
    const s = await setup();
    const job = await s.attach("now");
    await s.service.tick();
    await fs.appendFile(
      s.file,
      lines([event("task_started", { turn_id: "other-writer" })]),
    );
    await s.service.tick();
    expect(job.state).toBe("needs_attention");
    expect(job.recoveryRequired).toBe(true);
    expect(job.lastError).toContain("原会话");
  });
  it("pauses just the monitor at exit and restores external handoff state without dispatch", async () => {
    const s = await setup();
    const job = await s.attach();
    await s.service.shutdown();
    expect(job.state).toBe("paused");
    expect(s.driver.stop).not.toHaveBeenCalled();
    const restarted = new Store(s.store.root);
    await restarted.load();
    expect(restarted.data.jobs[0].state).toBe("needs_attention");
    expect(restarted.data.jobs[0].existing?.phase).toBe("watching");
  });
  it("can retry interrupted handoff after restart while preserving the same thread", async () => {
    const s = await setup();
    const job = await s.attach("now");
    s.driver.stop.mockRejectedValueOnce(new Error("timeout"));
    await s.service.tick();
    await s.service.control(job.id, "resume");
    expect(job.state).toBe("queued");
    expect(job.threadId).toBe(s.id);
    expect(s.driver.stop).toHaveBeenCalledTimes(2);
  });
});
it("resumes the copied history by path, validates identity and retains the original task context", async () => {
  const call = vi.fn(async () => ({ thread: { id: "expected" } }));
  await prepareThread(
    { call } as any,
    "expected",
    { cwd: "project" },
    "/owned/import.jsonl",
  );
  expect(call).toHaveBeenCalledWith("thread/resume", {
    threadId: "expected",
    cwd: "project",
    path: "/owned/import.jsonl",
  });
  call.mockResolvedValueOnce({ thread: { id: "wrong" } });
  await expect(
    prepareThread({ call } as any, "expected", {}, "/owned/import.jsonl"),
  ).rejects.toThrow("ID");
  expect(
    taskPrompt({
      job: { existing: {}, prompt: "original" },
      resumePrompt: "continue saved history",
    } as any),
  ).toBe("continue saved history");
});
it("validates session selection at the command boundary", () => {
  expect(
    sessionAttachSchema.safeParse({
      id: randomUUID(),
      mode: "cli",
      strategy: "quota",
      allowStop: false,
    }).success,
  ).toBe(true);
  expect(
    sessionAttachSchema.safeParse({
      id: randomUUID(),
      mode: "cli",
      strategy: "quota",
      allowStop: true,
      pid: 1,
    }).success,
  ).toBe(false);
  expect(sessionScanSchema.safeParse({ home: "relative" }).success).toBe(false);
});
