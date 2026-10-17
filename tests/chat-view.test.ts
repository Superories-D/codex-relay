import { expect, it } from "vitest";
import { mergePage, activityRuns, agentRows } from "../src/renderer/chat-view";
import type { ChatPage } from "../src/shared/types";
it("renders descendants under their parents without losing or looping on damaged ancestry", () => {
  const make = (threadId: string, parentThreadId: string) => ({
    threadId,
    parentThreadId,
    name: threadId,
    status: "completed",
    updatedAt: 0,
  });
  const rows = agentRows([
    make("nested", "child"),
    make("child", "root"),
    make("missing-parent", "absent"),
    make("cycle-a", "cycle-b"),
    make("cycle-b", "cycle-a"),
  ]);
  expect(rows.map((row) => [row.agent.threadId, row.depth])).toEqual([
    ["child", 0],
    ["nested", 1],
    ["missing-parent", 0],
    ["cycle-a", 0],
    ["cycle-b", 1],
  ]);
});
it("groups sequential work while preserving commentary, reasoning, agent controls and turn boundaries", () => {
  const make = (id: string, role: any, kind: string, turnId = "t1") => ({
    id,
    role,
    kind,
    turnId,
    text: id,
    at: 1,
  });
  const items = [
    make("a", "assistant", "message"),
    make("b", "tool", "commandExecution"),
    make("c", "tool", "fileChange"),
    make("d", "tool", "reasoning"),
    make("e", "tool", "commandExecution"),
    make("f", "tool", "subAgentActivity"),
    make("g", "tool", "commandExecution"),
    make("h", "tool", "commandExecution", "t2"),
  ];
  const runs = activityRuns(items);
  expect(runs.map((r) => r.items.map((i) => i.id))).toEqual([
    ["a"],
    ["b", "c"],
    ["d"],
    ["e"],
    ["f"],
    ["g"],
    ["h"],
  ]);
  expect(runs.map((r) => r.group)).toEqual([
    false,
    true,
    false,
    true,
    false,
    true,
    true,
  ]);
  expect(
    activityRuns([...items, make("i", "tool", "commandExecution", "t2")]).at(-1)
      ?.items[0].id,
  ).toBe("h");
});
it("reuses unchanged messages but exposes updated structured tool results", () => {
  const previous: ChatPage = {
    total: 2,
    items: [
      {
        id: "a",
        role: "assistant",
        kind: "message",
        text: "Stable answer",
        at: 1,
      },
      {
        id: "b",
        role: "tool",
        kind: "collabAgentToolCall",
        text: "Agent",
        at: 2,
        data: { agentsStates: { child: { status: "running" } } },
      },
    ],
  };
  expect(mergePage(previous, structuredClone(previous))).toBe(previous);
  const next = structuredClone(previous);
  next.items[1].data!.agentsStates.child.status = "completed";
  const merged = mergePage(previous, next);
  expect(merged.items[0]).toBe(previous.items[0]);
  expect(merged.items[1].data!.agentsStates.child.status).toBe("completed");
  expect(merged.items[1]).not.toBe(previous.items[1]);
});
