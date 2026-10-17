import type { ChatItem, ChatPage } from "../shared/types";

export function sameChatItem(previous: ChatItem, next: ChatItem) {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.kind === next.kind &&
      previous.role === next.role &&
      previous.text === next.text &&
      previous.detail === next.detail &&
      previous.status === next.status &&
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
