import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Desktop } from "../src/core/desktop";
import { gitConflict, gitStaged, gitUnstaged } from "../src/shared/git";

// Each case drives real Git child processes; retain a bounded integration timeout.
let root: string, project: string, desktop: Desktop;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-git-workspace-"));
  project = path.join(root, "project");
  await fs.mkdir(project);
  desktop = new Desktop(path.join(root, "profile"));
  await desktop.git(project, ["init", "-b", "main"]);
  await desktop.git(project, ["config", "user.name", "Relay QA"]);
  await desktop.git(project, ["config", "user.email", "qa@example.invalid"]);
  await desktop.git(project, ["config", "core.autocrlf", "false"]);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const write = (file: string, content: string) =>
  fs.writeFile(path.join(project, file), content);
async function initial(files: Record<string, string>) {
  for (const [file, content] of Object.entries(files))
    await write(file, content);
  await desktop.git(project, ["add", "."]);
  await desktop.gitAction(project, "commit", undefined, "initial");
}

it("unstages a first commit without deleting working files or other staged entries", async () => {
  await write("first.txt", "staged\n");
  await write("other.txt", "other\n");
  await desktop.gitAction(project, "stage", "first.txt");
  await desktop.gitAction(project, "stage", "other.txt");
  await write("first.txt", "working\n");
  const state = await desktop.gitAction(project, "unstage", "first.txt");
  expect(state.files.find((f) => f.path === "first.txt")).toMatchObject({
    index: "?",
    worktree: "?",
  });
  expect(state.files.find((f) => f.path === "other.txt")).toMatchObject({
    index: "A",
    worktree: " ",
  });
  expect(await fs.readFile(path.join(project, "first.txt"), "utf8")).toBe(
    "working\n",
  );
}, 20000);

it("lists nested untracked files separately and resolves their diff from a repository subdirectory", async () => {
  await fs.mkdir(path.join(project, "nested"));
  await write("nested/日本語 note.md", "nested 日本語\n");
  await write("nested/second.txt", "second\n");
  const cwd = path.join(project, "nested");
  const state = await desktop.changes(cwd);
  expect(state.files.map((f) => f.path).sort()).toEqual([
    "nested/second.txt",
    "nested/日本語 note.md",
  ]);
  expect(await desktop.diff(cwd, "nested/日本語 note.md")).toContain(
    "+nested 日本語",
  );
  expect(await desktop.diff(cwd, "nested/日本語 note.md", true)).toBe("");
  await desktop.gitAction(cwd, "stage", "nested/日本語 note.md");
  expect(
    (await desktop.changes(cwd)).files.find((f) =>
      f.path.endsWith("second.txt"),
    )?.index,
  ).toBe("?");
}, 20000);

it("treats bracket filenames as literal paths for stage, diff, unstage and restore", async () => {
  const target = "file[1].txt",
    neighbor = "file1.txt";
  await initial({ [target]: "target\n", [neighbor]: "neighbor\n" });
  await write(target, "target changed\n");
  await write(neighbor, "neighbor changed\n");
  await desktop.gitAction(project, "stage", target);
  const state = await desktop.changes(project);
  expect(state.files.find((f) => f.path === target)?.index).toBe("M");
  expect(state.files.find((f) => f.path === neighbor)?.index).toBe(" ");
  expect(await desktop.diff(project, target, true)).toContain(
    "+target changed",
  );
  expect(await desktop.diff(project, target, true)).not.toContain("neighbor");
  await desktop.gitAction(project, "unstage", target);
  await desktop.gitAction(project, "restore", target);
  expect(await fs.readFile(path.join(project, target), "utf8")).toBe(
    "target\n",
  );
  expect(await fs.readFile(path.join(project, neighbor), "utf8")).toBe(
    "neighbor changed\n",
  );
}, 20000);

it("shows a staged rename with its source and unstages both ends without modifying worktree content", async () => {
  await initial({
    "old name.txt": "unchanged content\n",
    "other.txt": "other\n",
  });
  await desktop.git(project, ["mv", "old name.txt", "新しい name.txt"]);
  await write("other.txt", "staged other\n");
  await desktop.gitAction(project, "stage", "other.txt");
  const entry = (await desktop.changes(project)).files.find(
    (f) => f.path === "新しい name.txt",
  )!;
  expect(entry.original).toBe("old name.txt");
  expect(gitStaged(entry)).toBe(true);
  expect(gitUnstaged(entry)).toBe(false);
  expect(await desktop.diff(project, entry.path, true)).toContain(
    "rename from old name.txt",
  );
  await desktop.gitAction(project, "unstage", entry.path);
  const staged = await desktop.git(project, [
    "diff",
    "--cached",
    "--name-only",
  ]);
  expect(staged.trim()).toBe("other.txt");
  await expect(fs.access(path.join(project, "old name.txt"))).rejects.toThrow();
  expect(await fs.readFile(path.join(project, entry.path), "utf8")).toBe(
    "unchanged content\n",
  );
}, 20000);

it("keeps staged and working changes distinct and restores only to the index", async () => {
  await initial({ "partial.txt": "base\n" });
  await write("partial.txt", "staged\n");
  await desktop.gitAction(project, "stage", "partial.txt");
  await write("partial.txt", "working\n");
  const entry = (await desktop.changes(project)).files[0];
  expect(gitStaged(entry) && gitUnstaged(entry)).toBe(true);
  expect(await desktop.diff(project, entry.path, true)).toContain("+staged");
  expect(await desktop.diff(project, entry.path)).toContain("+working");
  await desktop.gitAction(project, "restore", entry.path);
  expect(await fs.readFile(path.join(project, entry.path), "utf8")).toBe(
    "staged\n",
  );
  expect((await desktop.changes(project)).files[0]).toMatchObject({
    index: "M",
    worktree: " ",
  });
}, 20000);

it("marks merge conflicts without offering blind restore and stages an explicit resolution", async () => {
  await initial({ "conflict.txt": "base\n" });
  await desktop.git(project, ["checkout", "-b", "side"]);
  await write("conflict.txt", "side\n");
  await desktop.gitAction(project, "stage", "conflict.txt");
  await desktop.gitAction(project, "commit", undefined, "side");
  await desktop.git(project, ["checkout", "main"]);
  await write("conflict.txt", "main\n");
  await desktop.gitAction(project, "stage", "conflict.txt");
  await desktop.gitAction(project, "commit", undefined, "main");
  await expect(desktop.git(project, ["merge", "side"])).rejects.toThrow();
  const entry = (await desktop.changes(project)).files[0];
  expect(gitConflict(entry)).toBe(true);
  expect(gitStaged(entry)).toBe(false);
  await expect(
    desktop.gitAction(project, "restore", entry.path),
  ).rejects.toThrow("合并冲突");
  await write("conflict.txt", "resolved\n");
  await desktop.gitAction(project, "stage", entry.path);
  expect(gitConflict((await desktop.changes(project)).files[0])).toBe(false);
}, 20000);

it("isolates concurrent Git operations and working files in independent worktrees", async () => {
  await initial({ "shared.txt": "base\n" });
  const [a, b] = await Promise.all([
    desktop.worktree(project),
    desktop.worktree(project),
  ]);
  try {
    await fs.writeFile(path.join(a.cwd, "shared.txt"), "first worktree\n");
    await fs.writeFile(path.join(b.cwd, "shared.txt"), "second worktree\n");
    await Promise.all([
      desktop.gitAction(a.cwd, "stage", "shared.txt"),
      desktop.gitAction(b.cwd, "stage", "shared.txt"),
    ]);
    await Promise.all([
      desktop.gitAction(a.cwd, "commit", undefined, "first"),
      desktop.gitAction(b.cwd, "commit", undefined, "second"),
    ]);
    expect(await desktop.git(a.cwd, ["show", "HEAD:shared.txt"])).toBe(
      "first worktree\n",
    );
    expect(await desktop.git(b.cwd, ["show", "HEAD:shared.txt"])).toBe(
      "second worktree\n",
    );
    expect(await desktop.git(project, ["show", "HEAD:shared.txt"])).toBe(
      "base\n",
    );
    expect((await desktop.changes(project)).files).toEqual([]);
  } finally {
    await desktop.git(project, ["worktree", "remove", a.cwd]);
    await desktop.git(project, ["worktree", "remove", b.cwd]);
  }
}, 20000);
