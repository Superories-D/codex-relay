import type { ChatItem, ChatPage, AgentState } from "../shared/types";

export function agentRows(agents: AgentState[]) {
  const byId = new Map(agents.map((agent) => [agent.threadId, agent]));
  const children = new Map<string, AgentState[]>();
  for (const agent of byId.values()) {
    const parent = agent.parentThreadId || "";
    const list = children.get(parent) || [];
    list.push(agent);
    children.set(parent, list);
  }
  const rows: { agent: AgentState; depth: number }[] = [],
    seen = new Set<string>();
  const visit = (agent: AgentState, depth: number) => {
    if (seen.has(agent.threadId)) return;
    seen.add(agent.threadId);
    rows.push({ agent, depth });
    for (const child of children.get(agent.threadId) || [])
      visit(child, Math.min(depth + 1, 12));
  };
  for (const agent of byId.values())
    if (!agent.parentThreadId || !byId.has(agent.parentThreadId))
      visit(agent, 0);
  for (const agent of byId.values()) visit(agent, 0);
  return rows;
}

// Preserve assistant commentary, reasoning, plans and agent controls between runs.
// Use the first tool ID as the run key so live appends do not reset disclosure state.
export function activityRuns(items: ChatItem[]) {
  const runs: { group: boolean; items: ChatItem[] }[] = [];
  const separate = new Set([
    "reasoning",
    "plan",
    "collabAgentToolCall",
    "subAgentActivity",
    "imageView",
    "imageGeneration",
  ]);
  for (const item of items) {
    const activity =
      item.role === "tool" && !separate.has(item.kind) && !item.images?.length;
    const last = runs.at(-1);
    if (
      activity &&
      last?.group &&
      (!item.turnId ||
        !last.items[0].turnId ||
        item.turnId === last.items[0].turnId)
    )
      last.items.push(item);
    else runs.push({ group: activity, items: [item] });
  }
  return runs;
}

export function sameChatItem(previous: ChatItem, next: ChatItem) {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.kind === next.kind &&
      previous.role === next.role &&
      previous.text === next.text &&
      previous.detail === next.detail &&
      previous.status === next.status &&
      previous.sourceTruncated === next.sourceTruncated &&
      (previous.images === next.images ||
        JSON.stringify(previous.images) === JSON.stringify(next.images)) &&
      (previous.data === next.data ||
        JSON.stringify(previous.data) === JSON.stringify(next.data)))
  );
}
export function mergePage(previous: ChatPage, next: ChatPage): ChatPage {
  const old = new Map(previous.items.map((item) => [item.id, item]));
  const items = next.items.map((item) => {
    const cached = old.get(item.id);
    return cached && sameChatItem(cached, item) ? cached : item;
  });
  return previous.total === next.total &&
    previous.before === next.before &&
    previous.items.length === items.length &&
    items.every((item, index) => item === previous.items[index])
    ? previous
    : { ...next, items };
}
