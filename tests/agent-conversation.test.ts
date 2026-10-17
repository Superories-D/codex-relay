import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Scheduler } from "../src/core/scheduler";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { ProcessSafetyError } from "../src/core/process-safety-error";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/rpc", () => ({
  Rpc: { open: vi.fn(), assertHomeIdle: vi.fn(async () => {}) },
}));
const rootId = "11111111-1111-4111-8111-111111111111",
  childId = "22222222-2222-4222-8222-222222222222",
  grandId = "33333333-3333-4333-8333-333333333333";
let root: string, store: Store, scheduler: Scheduler, parent: Job, rpc: FakeRpc;
class FakeRpc extends EventEmitter {
  foreign = false;
  ephemeral = false;
  failClose = false;
  call = vi.fn(async (method: string, args: any): Promise<any> => {
    if (method === "thread/read")
      return {
        thread: {
          id: args.threadId,
          cwd: root,
          parentThreadId: this.foreign
            ? undefined
            : args.threadId === grandId
              ? childId
              : "parent-thread",
          ephemeral: this.ephemeral,
          createdAt: 1,
        },
      };
    if (method === "thread/resume")
      return {
        thread: { id: args.threadId },
        cwd: root,
        model: "native-child-model",
        reasoningEffort: "high",
        approvalPolicy: "untrusted",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [root],
          networkAccess: false,
        },
      };
    if (method === "thread/turns/list")
      return args.cursor
        ? {
            data: [
              {
                id: "turn-2",
                status: "completed",
                startedAt: 2,
                items: [
                  {
                    id: "u2",
                    type: "userMessage",
                    content: [{ type: "text", text: "Continue" }],
                  },
                  { id: "a2", type: "agentMessage", text: "Continued" },
                ],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: "turn-1",
                status: "completed",
                startedAt: 1,
                items: [
                  {
                    id: "u1",
                    type: "userMessage",
                    content: [{ type: "text", text: "Original child task" }],
                  },
                  { id: "a1", type: "agentMessage", text: "Original answer" },
                ],
              },
            ],
            nextCursor: "next",
          };
    throw Error(`Unexpected operation ${method}`);
  });
  close = vi.fn(async () => {
    expect(store.data.jobs).toHaveLength(1); // Adoption commits only after close.
    if (this.failClose)
      throw new ProcessSafetyError("owned process still alive", Error("test"));
  });
  reject = vi.fn();
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-agent-chat-"));
  store = new Store(root);
  store.data.settings.resetWarmupEnabled = false;
  parent = {
    id: rootId,
    title: "Parent",
    cwd: root,
    prompt: "",
    mode: "cli",
    model: "parent-model",
    effort: "low",
    bucket: "codex",
    state: "completed",
    threadId: "parent-thread",
    rotations: 0,
    createdAt: 1,
    updatedAt: 1,
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
    agents: [
      {
        threadId: childId,
        parentThreadId: "parent-thread",
        name: "Scout",
        status: "completed",
        updatedAt: 1,
      },
      {
        threadId: grandId,
        parentThreadId: childId,
        name: "Nested",
        status: "completed",
        updatedAt: 1,
      },
    ],
  };
  store.data.jobs.push(parent);
  rpc = new FakeRpc();
  vi.mocked(Rpc.open).mockResolvedValue(rpc as any);
  scheduler = new Scheduler(
    store,
    { cancelLogin: async () => {}, busy: new Set() } as any,
    {
      cli: () => {
        throw Error("No model execution allowed");
      },
      desktop: () => {
        throw Error("No desktop execution allowed");
      },
    },
  );
});
afterEach(async () => {
  await scheduler.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
it("opens the original child without credentials or inference, preserving native permissions, complete history and descendant ownership", async () => {
  await scheduler.chats.user(childId, "Continue");
  const priorUser = (await scheduler.chats.read(childId)).items[0].id;
  await scheduler.chats.append(childId, {
    id: "turn-1:a1",
    role: "assistant",
    kind: "message",
    text: "Original answer",
    at: 1200,
  });
  const child = await scheduler.openAgent(rootId, childId);
  expect(child).toMatchObject({
    id: childId,
    threadId: childId,
    runtimeHomeId: rootId,
    state: "completed",
    model: "native-child-model",
    effort: "high",
    sandbox: "workspaceWrite",
    preserveNativePermissions: true,
    agentOrigin: { jobId: rootId, parentThreadId: "parent-thread" },
    turnId: "turn-2",
    agents: [{ threadId: grandId }],
  });
  expect(parent.state).toBe("completed");
  expect(parent.agents![0].conversationId).toBe(child.id);
  expect(store.jobHome(child.id)).toBe(store.jobHome(parent.id));
  expect(rpc.call).toHaveBeenCalledWith("thread/resume", {
    threadId: childId,
    excludeTurns: true,
    config: { "features.goals": false },
  });
  expect(
    rpc.call.mock.calls.every(
      ([m]) =>
        ![
          "thread/fork",
          "thread/start",
          "turn/start",
          "account/login/start",
        ].includes(m),
    ),
  ).toBe(true);
  const history = await scheduler.chats.read(child.id);
  expect(history.items.map((item) => item.text)).toEqual([
    "Original child task",
    "Original answer",
    "Continue",
    "Continued",
  ]);
  expect(history.items.find((item) => item.text === "Continue")!.id).toBe(
    priorUser,
  );
  expect((await scheduler.chats.read(rootId)).total).toBe(0);
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.jobs[1].agentOrigin).toEqual(child.agentOrigin);
  vi.mocked(Rpc.open).mockClear();
  expect((await scheduler.openAgent(rootId, childId)).id).toBe(child.id);
  expect(Rpc.open).not.toHaveBeenCalled();
  expect(store.data.jobs).toHaveLength(2);
});
it("verifies a nested child's native ancestor chain before adopting it", async () => {
  const grand = await scheduler.openAgent(rootId, grandId);
  expect(grand.agentOrigin).toEqual({ jobId: rootId, parentThreadId: childId });
  expect(
    rpc.call.mock.calls
      .filter(([m]) => m === "thread/read")
      .map(([, a]) => a.threadId),
  ).toEqual([grandId, childId]);
});
it("keeps client question records and stored media when reconciling native history", async () => {
  const image = path.join(root, "image.png");
  await fs.writeFile(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await scheduler.chats.append(childId, {
    id: "turn-1:a1",
    role: "assistant",
    kind: "message",
    text: "Original answer",
    at: 1,
    images: [
      { id: "saved", origin: "generated", name: "image.png", path: image },
    ],
  });
  const approval: any = {
    id: "q",
    jobId: childId,
    historyId: "question:kept",
    createdAt: 5,
    kind: "input",
    params: {
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  };
  await scheduler.chats.question(approval, "answered", {
    choice: { answers: ["Keep history"] },
  });
  await scheduler.openAgent(rootId, childId);
  const history = await scheduler.chats.read(childId);
  expect(history.items.find((i) => i.id === "turn-1:a1")?.images?.[0].id).toBe(
    "saved",
  );
  expect((await scheduler.chats.questions(childId)).items[0]).toMatchObject({
    status: "answered",
    answers: { choice: { answers: ["Keep history"] } },
  });
});
it("refuses a forged lineage, ephemeral history and unowned thread without creating aliases", async () => {
  rpc.foreign = true;
  await expect(scheduler.openAgent(rootId, childId)).rejects.toThrow(
    "父子关系",
  );
  rpc.foreign = false;
  rpc.ephemeral = true;
  await expect(scheduler.openAgent(rootId, childId)).rejects.toThrow(
    "临时子代理",
  );
  await expect(scheduler.openAgent(rootId, "unowned")).rejects.toThrow(
    "不属于",
  );
  expect(store.data.jobs).toHaveLength(1);
  expect(rpc.call.mock.calls.some(([m]) => m === "thread/resume")).toBe(false);
});
it("does not expose a new conversation until its metadata process is confirmed closed", async () => {
  rpc.failClose = true;
  await expect(scheduler.openAgent(rootId, childId)).rejects.toBeInstanceOf(
    ProcessSafetyError,
  );
  expect(store.data.jobs).toHaveLength(1);
  expect(parent.recoveryRequired).toBe(true);
  expect(parent.state).toBe("needs_attention");
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.jobs[0].recoveryRequired).toBe(true);
});
it("rolls back the alias and ancestor link when its durable commit fails", async () => {
  vi.spyOn(store, "save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.openAgent(rootId, childId)).rejects.toThrow(
    "disk full",
  );
  expect(store.data.jobs).toHaveLength(1);
  expect(parent.agents![0].conversationId).toBeUndefined();
});
