export interface ReviewLine {
  index: number;
  text: string;
  kind: "added" | "removed" | "context" | "note";
  oldLine?: number;
  newLine?: number;
}

export interface ReviewHunk {
  index: number;
  header: string;
  lines: ReviewLine[];
  added: number;
  removed: number;
}

// Display parsing is separate from gitHunks' stricter patch eligibility. In
// particular, renamed text may be readable without being safe to stage by hunk.
// Unrecognized/truncated/combined output stays visible verbatim, without invented
// line numbers or line-specific feedback.
export function reviewDiff(diff: string) {
  const raw = diff.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const starts = raw.flatMap((line, index) =>
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? [index] : [],
  );
  const fallback = {
    metadata: raw,
    hunks: [] as ReviewHunk[],
    added: 0,
    removed: 0,
  };
  if (
    !starts.length ||
    !raw[0]?.startsWith("diff --git ") ||
    raw.filter((line) => line.startsWith("diff --git ")).length !== 1
  )
    return fallback;
  const hunks: ReviewHunk[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i],
      end = starts[i + 1] ?? raw.length;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
      raw[start],
    )!;
    let oldLine = Number(match[1]),
      newLine = Number(match[3]);
    const hunk: ReviewHunk = {
      index: i,
      header: raw[start],
      lines: [],
      added: 0,
      removed: 0,
    };
    for (let index = start + 1; index < end; index++) {
      const text = raw[index];
      const line: ReviewLine = { index, text, kind: "note" };
      if (text.startsWith("+")) {
        line.kind = "added";
        line.newLine = newLine++;
        hunk.added++;
      } else if (text.startsWith("-")) {
        line.kind = "removed";
        line.oldLine = oldLine++;
        hunk.removed++;
      } else if (text.startsWith(" ")) {
        line.kind = "context";
        line.oldLine = oldLine++;
        line.newLine = newLine++;
      } else if (text !== "\\ No newline at end of file") return fallback;
      hunk.lines.push(line);
    }
    if (
      oldLine - Number(match[1]) !== Number(match[2] ?? 1) ||
      newLine - Number(match[3]) !== Number(match[4] ?? 1)
    )
      return fallback;
    hunks.push(hunk);
  }
  return {
    metadata: raw.slice(0, starts[0]),
    hunks,
    added: hunks.reduce((total, hunk) => total + hunk.added, 0),
    removed: hunks.reduce((total, hunk) => total + hunk.removed, 0),
  };
}

export function reviewLocation(path: string, line: ReviewLine) {
  return `${path}:${line.newLine ?? line.oldLine}`;
}

export function reviewExcerpt(line: ReviewLine, hunk: ReviewHunk) {
  const index = hunk.lines.indexOf(line);
  return [
    hunk.header,
    ...hunk.lines
      .slice(Math.max(0, index - 2), index + 3)
      .map((row) => row.text),
  ].join("\n");
}

export function reviewCodeBlock(excerpt: string) {
  let length = 3;
  for (const match of excerpt.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}diff\n${excerpt}\n${fence}`;
}
