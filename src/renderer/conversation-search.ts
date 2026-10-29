export interface TextMatch { start: number; end: number }
const fold = (value: string) => value.normalize("NFKC").toLowerCase();
/** Literal search with offsets into the original text, including full-width/ligature matches. */
export function textMatches(text: string, query: string, limit = 1000): { matches: TextMatch[]; limited: boolean } {
  const needle = fold(query.trim());
  if (!needle || limit < 1) return { matches: [], limited: false };
  const normalized = text.normalize("NFKC"), lowered = normalized.toLowerCase();
  let starts: number[] | undefined, ends: number[] | undefined;
  if (normalized !== text || lowered.length !== text.length) {
    starts = []; ends = [];
    // Graphemes keep combining marks attached to the source character.
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const part of segmenter.segment(text)) {
      for (let i = 0; i < fold(part.segment).length; i++) {
        starts.push(part.index); ends.push(part.index + part.segment.length);
      }
    }
  }
  const matches: TextMatch[] = [];
  let offset = 0;
  for (;;) {
    const at = lowered.indexOf(needle, offset);
    if (at < 0) return { matches, limited: false };
    const match = { start: starts?.[at] ?? at, end: ends?.[at + needle.length - 1] ?? at + needle.length };
    const previous = matches.at(-1);
    if (previous && match.start < previous.end) previous.end = Math.max(previous.end, match.end);
    else {
      if (matches.length === limit) return { matches, limited: true };
      matches.push(match);
    }
    offset = at + needle.length;
  }
}
export type SearchItem = { id: string; role: "user" | "assistant" | "tool" | "system"; at: number; excerpt: string };
export type SearchPage = { items: SearchItem[]; total: number; next?: number };
export function searchPageValue(value: SearchPage, offset: number): SearchPage {
  // Cursor progress prevents accidental loops if an older service returns a stale next value.
  return { ...value, ...(value.next !== undefined && value.next > offset ? {next: value.next} : {next: undefined}) };
}
export function searchContext(id: string, query: string, role: string, offset: number) {
  return JSON.stringify([id, query.trim(), role, offset]);
}
export function moveSearchSelection(current: number, direction: -1 | 1, count: number) {
  return Math.max(0, Math.min(count - 1, current + direction));
}
