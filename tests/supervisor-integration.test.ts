import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { Store } from "../src/core/store";
import { Scheduler } from "../src/core/scheduler";
import { CliWorker } from "../src/core/cli-worker";
import {recoverJob} from "../src/core/recovery";
import { ExistingSessions } from "../src/core/existing-sessions";
import { randomUUID } from "node:crypto";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/process")>();
  return {
    ...actual,
    spawnCodex: async (_cli: string, _args: string[], home: string) =>
      spawn(
        process.execPath,
        [
          path.join(
            process.cwd(),
            "tests/fixtures",
            _cli === "fixture-agents"
              ? "agents-app-server.cjs"
              : "app-server.cjs",
          ),
        ],
        {
          env: {
            ...process.env,
            RELAY_TEST_HOME: home,
            RELAY_TEST_MISSING_EVENT:
              _cli === "fixture-missing-event" ? "1" : "",
            RELAY_TEST_RECOVERY: _cli.startsWith("fixture-recovery-")
              ? _cli.slice("fixture-recovery-".length)
              : "",
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
  };
});
it("restores a real JSONL completion after a lost cleanup acknowledgement without another turn/start",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-completed-recovery-")),store=new Store(root);
 store.data.settings.resetWarmupEnabled=false;
 store.data.accounts=[{id:"b",identity:"b",label:"test",email:"",plan:"test",enabled:true,status:"ready",failureCount:0,blockedUntil:null,
  quotas:{codex:{limitId:"codex",reached:false,observedAt:Date.now(),primary:{usedPercent:10,windowDurationMins:300,resetsAt:Date.now()+3600000},secondary:null}}}];
 const accounts:any={busy:new Set(),cancelLogin:async()=>{},inspect:async()=>({auth:{tokens:{access_token:"synthetic"}},models:[],quotas:store.data.accounts[0].quotas})};
 let starts=0,closeFailed=false;
 const factories={cli:(ctx:any)=>{starts++;const worker=new CliWorker(ctx),close=worker.close.bind(worker);worker.close=async()=>{await close();if(!closeFailed){closeFailed=true;throw Error("Lost cleanup acknowledgement");}};return worker;},desktop:()=>{throw Error("not used");}};
 const original=new Scheduler(store,accounts,factories);let restored:Scheduler|undefined;
 try{
  const job=await original.add({title:"Known success",prompt:"Finish once",cwd:root,interactive:true,mode:"cli",model:"",effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite"});
  await vi.waitFor(()=>expect(job.completionPending).toBe(true),{timeout:5000});await(original as any).currentRun;expect(job.recoveryRequired).toBe(true);await store.save();
  const saved=await fs.readFile(path.join(root,"state.json")),journalPath=path.join(store.jobHome(job.id),"synthetic-journal.jsonl");
  const first=JSON.parse((await fs.readFile(journalPath,"utf8")).trim());expect(()=>process.kill(first.pid,0)).toThrow();
  await original.shutdown();await fs.writeFile(path.join(root,"state.json"),saved);
  const disk=new Store(root);await disk.load();const pending=disk.data.jobs[0];pending.autoRecovery!.nextAttemptAt=0;
  restored=new Scheduler(disk,accounts,factories,j=>recoverJob(j,disk,accounts,root));restored.start();
  await vi.waitFor(()=>expect(pending.state).toBe("completed"),{timeout:5000});await(restored as any).currentRun;
  expect(starts).toBe(1);expect((await fs.readFile(journalPath,"utf8")).trim().split("\n")).toHaveLength(1);
  expect(pending.completionPending).toBeUndefined();expect(pending.completion?.revision).toBe(1);expect(pending.recoveryRequired).toBe(false);
 }finally{await restored?.shutdown();await original.shutdown();await fs.rm(root,{recursive:true,force:true});}
},15000);
it.each([false, true])(
  "real JSONL processes confirm shutdown before same-thread quota relay (missing interrupt event: %s)",
  async (missingEvent) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-integration-"));
    const store = new Store(root);
    if (missingEvent) store.data.settings.cliPath = "fixture-missing-event";
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
        timeout: missingEvent ? 30000 : 5000,
        interval: 10,
      });
      await (scheduler as any).currentRun;
      expect(job.state).toBe("queued");
      expect(job.threadId).toBe("synthetic-thread");
      const firstRun = JSON.parse(
        (
          await fs.readFile(
            path.join(store.jobHome(job.id), "synthetic-journal.jsonl"),
            "utf8",
          )
        ).trim(),
      );
      expect(() => process.kill(firstRun.pid, 0)).toThrow();
      expect(job.recoveryRequired).not.toBe(true);
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
  },
  45000,
);
it("hands off an existing rollout and drives the real worker to completion with the same thread", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-adopt-integration-"),
  );
  const home = path.join(root, "original"),
    store = new Store(path.join(root, "relay")),
    id = randomUUID();
  const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original =
    [
      { type: "session_meta", payload: { id, cwd: root, source: "cli" } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "prior" },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Finish the original project",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "error",
          codex_error_info: "usage_limit_exceeded",
          message: "quota",
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n";
  await fs.writeFile(file, original);
  const quota: any = {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: Date.now() + 100000,
      },
      secondary: null,
      observedAt: Date.now(),
      reached: false,
    },
  };
  store.data.accounts = [
    {
      id: "b",
      identity: "b",
      label: "b",
      email: "test",
      plan: "test",
      enabled: true,
      status: "ready",
      blockedUntil: null,
      failureCount: 0,
      quotas: quota,
    },
  ];
  const accounts: any = {
    busy: new Set(),
    inspect: async () => ({
      auth: { tokens: { access_token: "synthetic" } },
      models: [],
      quotas: quota,
    }),
    cancelLogin: async () => {},
    drain: async () => {},
  };
  const driver = {
    inspect: async () => ({ processes: [], canHandoff: true }),
    stop: vi.fn(async () => {}),
  };
  let service: ExistingSessions;
  const scheduler = new Scheduler(
    store,
    accounts,
    {
      cli: (ctx) => new CliWorker(ctx),
      desktop: () => {
        throw Error("unused");
      },
    },
    undefined,
    (job) => service.assertManagedSafe(job),
  );
  service = new ExistingSessions(store, scheduler, driver);
  try {
    const scan = await service.scan(home);
    const handle = scan.candidates[0].id;
    await service.inspect(handle);
    const job = await service.attach({
      id: handle,
      mode: "cli",
      strategy: "quota",
      allowStop: false,
    });
    expect(job.state).toBe("watching");
    await service.tick();
    expect(job.state).toBe("queued");
    await (scheduler as any).tick();
    await vi.waitFor(() => expect(job.state).toBe("completed"), {
      timeout: 5000,
    });
    await (scheduler as any).currentRun;
    const journal = JSON.parse(
      (
        await fs.readFile(
          path.join(store.jobHome(job.id), "synthetic-journal.jsonl"),
          "utf8",
        )
      ).trim(),
    );
    expect(journal.threadId).toBe(id);
    expect(journal.input).toContain("Finish the original project");
    expect(journal.input).toContain("不要重复");
    expect(job.importedRollout).toBeUndefined();
    expect(job.desktopSubmissionPending).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  } finally {
    await service.shutdown();
    await scheduler.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);

it("preserves a nested agent graph and Goal accounting through subprocess quota relay and child continuation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-nested-"));
  const store = new Store(root);
  store.data.settings.cliPath = "fixture-agents";
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
          resetsAt: Date.now() + 3600000,
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
  const wait = async (check: () => void) =>
    vi.waitFor(check, { timeout: 8000, interval: 20 });
  try {
    const job = await scheduler.add({
      title: "Nested goal",
      prompt: "Preserve the entire nested task",
      cwd: root,
      mode: "cli",
      model: "",
      effort: "",
      bucket: "codex",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
      interactive: true,
    });
    await wait(() =>
      expect(
        job.agents?.find((a) => a.threadId === "agent-nested"),
      ).toMatchObject({
        parentThreadId: "agent-child",
        model: "synthetic-nested",
        effort: "high",
        status: "running",
      }),
    );
    const home = store.jobHome(job.id);
    const journal = async () =>
      (await fs.readFile(path.join(home, "agents-journal.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const originalPid = (await journal())[0].pid;
    await fs.writeFile(path.join(home, "exhaust-nested"), "");
    await wait(() => expect(job.rotations).toBe(1));
    await (scheduler as any).currentRun;
    expect(job.state).toBe("queued");
    expect(job.goalResumeAfterQuota).toBe(true);
    expect(() => process.kill(originalPid, 0)).toThrow();
    await (scheduler as any).tick();
    await wait(() => expect(job.state).toBe("running"));
    expect(job.accountId).toBe("b");
    expect(job.threadId).toBe("agent-root");
    expect(job.goal).toMatchObject({
      status: "active",
      objective: "Preserve the entire nested task",
      tokenBudget: 50000,
      tokensUsed: 1234,
    });
    expect(
      job.agents?.find((a) => a.threadId === "agent-nested"),
    ).toMatchObject({
      parentThreadId: "agent-child",
      effort: "high",
      status: "interrupted",
    });
    await scheduler.agentControl(
      job.id,
      "agent-nested",
      "send",
      "Continue the nested work",
    );
    expect(
      job.agents?.find((a) => a.threadId === "agent-nested"),
    ).toMatchObject({
      turnId: "newer-b",
      status: "running",
      parentThreadId: "agent-child",
    });
    await scheduler.agentControl(job.id, "agent-nested", "interrupt");
    expect(job.agents?.find((a) => a.threadId === "agent-nested")?.status).toBe(
      "interrupted",
    );
    await scheduler.control(job.id, "pause");
    expect(job.state).toBe("paused");
    expect(job.goal?.status).toBe("paused");
    const events = await journal();
    expect(
      events
        .filter((e) => e.account === "b" && e.method === "turn/start")
        .map((e) => e.threadId),
    ).toEqual(["agent-nested"]);
    expect(
      events.find((e) => e.account === "b" && e.method === "thread/goal/set")
        ?.params,
    ).toEqual({
      threadId: "agent-root",
      status: "active",
      origin: "automatic",
    });
    expect(
      events.find((e) => e.account === "b" && e.method === "turn/start")
        ?.effort,
    ).toBe("high");
    const restored = new Store(root);
    await restored.load();
    expect(
      restored.data.jobs[0].agents?.find((a) => a.threadId === "agent-nested"),
    ).toMatchObject({
      parentThreadId: "agent-child",
      effort: "high",
      turnId: "newer-b",
    });
    await expect(
      fs.stat(path.join(home, "relay-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await scheduler.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20000);

it("runs real isolated JSONL processes concurrently on one account and pauses only the selected thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-parallel-"));
  const store = new Store(root);
  const quotas = {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: Date.now() + 3600000,
      },
      secondary: null,
      observedAt: Date.now(),
      reached: false,
    },
  };
  const accounts: any = {
    busy: new Set(),
    inspect: async () => ({
      auth: { tokens: { access_token: "synthetic" } },
      models: [],
      quotas,
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
    const jobs: Job[] = [];
    for (let i = 0; i < 2; i++) {
      const job = await scheduler.add({
        title: `Parallel ${i}`,
        prompt: `Independent task ${i}`,
        cwd: root,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
        interactive: true,
      });
      await (scheduler as any).tickInFlight;
      await fs.mkdir(store.jobHome(job.id), { recursive: true });
      await fs.writeFile(
        path.join(store.jobHome(job.id), "parallel-fixture.json"),
        "{}",
      );
      jobs.push(job);
    }
    store.data.accounts = [
      {
        id: "shared",
        identity: "shared",
        label: "shared",
        email: "synthetic",
        plan: "test",
        enabled: true,
        status: "ready",
        blockedUntil: null,
        failureCount: 0,
        quotas,
      },
    ];
    await (scheduler as any).tick();
    await vi.waitFor(
      () => expect(jobs.map((j) => j.state)).toEqual(["running", "running"]),
      { timeout: 5000 },
    );
    const journals = await Promise.all(
      jobs.map(async (j) =>
        JSON.parse(
          (
            await fs.readFile(
              path.join(store.jobHome(j.id), "synthetic-journal.jsonl"),
              "utf8",
            )
          ).trim(),
        ),
      ),
    );
    expect(new Set(journals.map((j) => j.pid)).size).toBe(2);
    expect(new Set(jobs.map((j) => j.threadId)).size).toBe(2);
    expect(journals.map((j) => j.account)).toEqual(["shared", "shared"]);
    await scheduler.control(jobs[0].id, "pause");
    expect(jobs.map((j) => j.state)).toEqual(["paused", "running"]);
    await fs.writeFile(
      path.join(store.jobHome(jobs[1].id), "complete-turn"),
      "",
    );
    await vi.waitFor(() => expect(jobs[1].state).toBe("completed"), {
      timeout: 5000,
    });
    await (scheduler as any).currentRun;
    const saved = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8"),
    );
    expect(saved.jobs.map((j: any) => j.state)).toEqual([
      "paused",
      "completed",
    ]);
    expect(jobs[0].rotations).toBe(0);
    expect(jobs[1].rotations).toBe(0);
  } finally {
    await scheduler.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);

it.each(["unknown", "interrupted", "disconnect", "lost-ack"])(
  "automatically recovers %s through real JSONL process replacement without a Continue click",
  async (scenario) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "relay-auto-recovery-"),
    );
    const store = new Store(root);
    store.data.settings.cliPath = `fixture-recovery-${scenario}`;
    store.data.settings.resetWarmupEnabled = false;
    store.data.accounts = [
      {
        id: "b",
        identity: "b",
        label: "test",
        email: "",
        plan: "test",
        enabled: true,
        status: "ready",
        failureCount: 0,
        blockedUntil: null,
        quotas: {
          codex: {
            limitId: "codex",
            reached: false,
            observedAt: Date.now(),
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: Date.now() + 3600000,
            },
            secondary: null,
          },
        },
      },
    ];
    const accounts: any = {
      busy: new Set(),
      cancelLogin: async () => {},
      inspect: async () => ({
        auth: { tokens: { access_token: "synthetic" } },
        models: [],
        quotas: store.data.accounts[0].quotas,
      }),
    };
    const scheduler = new Scheduler(store, accounts, {
      cli: (ctx) => new CliWorker(ctx),
      desktop: () => {
        throw Error("not used");
      },
    });
    try {
      const job = await scheduler.add({
        title: "Automatic recovery",
        prompt: "Original request",
        cwd: root,
        interactive: true,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      await vi.waitFor(() => expect(job.autoRecovery).toBeDefined(), {
        timeout: 5000,
      });
      await (scheduler as any).currentRun;
      const journalPath = path.join(
        store.jobHome(job.id),
        "synthetic-journal.jsonl",
      );
      const first = JSON.parse((await fs.readFile(journalPath, "utf8")).trim());
      expect(() => process.kill(first.pid, 0)).toThrow();
      expect(job.threadId).toBe("synthetic-thread");
      expect(job.submissionUncertain).toBe(scenario === "lost-ack");
      // Start the normal scheduler loop and let the persisted backoff elapse.
      scheduler.start();
      await vi.waitFor(() => expect(job.state).toBe("completed"), {
        timeout: 8000,
      });
      await (scheduler as any).currentRun;
      const journal = (await fs.readFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(journal).toHaveLength(2);
      expect(journal[0].pid).not.toBe(journal[1].pid);
      expect(journal.map((j) => j.threadId)).toEqual([
        "synthetic-thread",
        "synthetic-thread",
      ]);
      expect(journal[0].input).toBe("Original request");
      if (scenario === "lost-ack") {
        expect(journal[1].input).toContain("上次发送结果未确认");
        expect(journal[1].input).toContain("Original request");
        expect(journal[1].input).not.toBe(journal[0].input);
      } else expect(journal[1].input).toBe(store.data.settings.resumePrompt);
      expect(job.pendingMessage).toBeUndefined();
      expect(job.autoRecovery).toBeUndefined();
      expect(job.recoveryAttempts).toBe(0);
      expect(job.rotations).toBe(0);
    } finally {
      await scheduler.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
