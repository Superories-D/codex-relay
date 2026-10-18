export interface GitChange {
  path: string;
  index: string;
  worktree: string;
  original?: string;
}
export interface GitChanges {
  root: string;
  branch: string;
  files: GitChange[];
  error: string;
}
export const gitConflict = (file: GitChange) =>
  ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
    file.index + file.worktree,
  );
export const gitStaged = (file: GitChange) =>
  !gitConflict(file) && ![" ", "?", "!"].includes(file.index);
export const gitUnstaged = (file: GitChange) =>
  file.worktree !== " " && file.worktree !== "!";

export function parseGitStatus(raw: string): GitChange[] {
  const rows = raw.split("\0"),
    files: GitChange[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const entry: GitChange = {
      path: row.slice(3),
      index: row[0],
      worktree: row[1],
    };
    if (/[RC]/.test(row.slice(0, 2))) entry.original = rows[++i];
    files.push(entry);
  }
  return files;
}
