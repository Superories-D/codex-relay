export interface GitHunk {
  line: number;
  end: number;
}

// Only ordinary single-file text patches are eligible. A rename, mode change,
// symlink, submodule or combined merge diff must remain a whole-file operation.
export function gitHunks(diff: string): GitHunk[] {
  // execFile decodes Git output as UTF-8. Never construct a text patch from
  // replacement characters that may stand for undecodable source bytes.
  if (diff.includes("\uFFFD")) return [];
  const lines = diff.split("\n");
  const starts = lines.flatMap((line, index) =>
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? [index] : [],
  );
  if (!starts.length || !lines[0].startsWith("diff --git ")) return [];
  const header = lines.slice(0, starts[0]);
  if (header.some((line, i) => i > 0 && !(
    /^index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?$/.test(line) ||
    /^(?:new|deleted) file mode 100(?:644|755)$/.test(line) ||
    line.startsWith("--- ") || line.startsWith("+++ ")
  ))) return [];
  if (header.filter((line) => line.startsWith("--- ")).length !== 1 ||
      header.filter((line) => line.startsWith("+++ ")).length !== 1) return [];
  const hunks: GitHunk[] = [];
  for (let i = 0; i < starts.length; i++) {
    const line = starts[i], end = starts[i + 1] ?? lines.length;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[line])!;
    let oldCount = 0, newCount = 0, changes = 0;
    for (let n = line + 1; n < end; n++) {
      const row = lines[n];
      if (n === lines.length - 1 && row === "") continue;
      if (row === "\\ No newline at end of file") continue;
      if (row[0] === " ") { oldCount++; newCount++; }
      else if (row[0] === "-") { oldCount++; changes++; }
      else if (row[0] === "+") { newCount++; changes++; }
      else return []; // Truncated, binary or additional-file payload.
    }
    if (!changes || oldCount !== Number(match[2] ?? 1) ||
        newCount !== Number(match[4] ?? 1)) return [];
    hunks.push({ line, end });
  }
  return hunks;
}

export function gitHunkPatch(diff: string, index: number): string | undefined {
  const hunks = gitHunks(diff);
  const selected = Number.isInteger(index) && index >= 0 ? hunks[index] : undefined;
  if (!selected) return;
  const lines = diff.split("\n");
  const patch = [...lines.slice(0, hunks[0].line), ...lines.slice(selected.line, selected.end)].join("\n");
  return patch.endsWith("\n") ? patch : patch + "\n";
}
