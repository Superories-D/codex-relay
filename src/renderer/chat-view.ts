import type { ChatItem, ChatPage } from "../shared/types";

// Preserve assistant commentary, reasoning, plans and agent controls between runs.
// Use the first tool ID as the run key so live appends do not reset disclosure state.
export function activityRuns(items: ChatItem[]) {
  const runs: { group: boolean; items: ChatItem[] }[] = [];
  const separate = new Set([
    "reasoning",
    "plan",
    "collabAgentToolCall",
    "subAgentActivity",
  ]);
  for (const item of items) {
    const activity = item.role === "tool" && !separate.has(item.kind);
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
