import { expect, it } from "vitest";
import { mergePage } from "../src/renderer/chat-view";
import type { ChatPage } from "../src/shared/types";
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
