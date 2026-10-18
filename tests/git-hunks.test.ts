import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { Desktop } from "../src/core/desktop";
import { gitHunks, gitHunkPatch } from "../src/shared/git-hunks";

let root: string, repo: string, desktop: Desktop;
const file = "日本語 [1].txt";
const original = Array.from({ length: 32 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-hunks-"));
  repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "nested"), { recursive: true });
  desktop = new Desktop(path.join(root, "profile"));
  await desktop.git(repo, ["init", "-b", "main"]);
  await desktop.git(repo, ["config", "user.name", "Hunk QA"]);
  await desktop.git(repo, ["config", "user.email", "qa@example.invalid"]);
  await desktop.git(repo, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repo, file), original);
  await desktop.git(repo, ["add", "."]);
  await desktop.git(repo, ["commit", "-m", "initial"]);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = (text: string) => fs.writeFile(path.join(repo, file), text);
async function change(staged: boolean, hunk: number, relative = file, cwd = repo) {
  const state = await desktop.changes(cwd);
  const diff = await desktop.diff(cwd, relative, staged);
  return desktop.gitHunk(cwd, relative, staged, hunk, state.revision, diff);
}

it("stages the second hunk from a nested project without staging the first or another file, then unstages only one hunk", async () => {
  await desktop.git(repo, ["config", "diff.noprefix", "true"]);
  await desktop.git(repo, ["config", "diff.context", "100"]);
  await desktop.git(repo, ["config", "diff.interHunkContext", "100"]);
  const first = original.replace("line 2\n", "first\nextra line\n");
  const both = first.replace("line 29\n", "second\n");
  await write(both);
  await fs.writeFile(path.join(repo, "other.txt"), "unrelated staged content\n");
  await desktop.git(repo, ["add", "other.txt"]);
  const diff = await desktop.diff(repo, file);
  expect(gitHunks(diff)).toHaveLength(2);
  await change(false, 1, file, path.join(repo, "nested"));
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original.replace("line 29\n", "second\n"));
  expect(await fs.readFile(path.join(repo, file), "utf8")).toBe(both);
  await change(false, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(both);
  await change(true, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original.replace("line 29\n", "second\n"));
  expect(await desktop.git(repo, ["show", ":other.txt"])).toBe("unrelated staged content\n");
  expect(await fs.readFile(path.join(repo, file), "utf8")).toBe(both);
}, 20000);

it("stages an intent-to-add text file and reverses a staged addition before the first commit", async () => {
  const empty = path.join(root, "unborn");
  await fs.mkdir(empty);
  await desktop.git(empty, ["init"]);
  await desktop.git(empty, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(empty, "new.txt"), "new text without newline");
  await desktop.git(empty, ["add", "--intent-to-add", "new.txt"]);
  await change(false, 0, "new.txt", empty);
  expect(await desktop.git(empty, ["show", ":new.txt"])).toBe("new text without newline");
  await change(true, 0, "new.txt", empty);
  expect((await desktop.changes(empty)).files).toMatchObject([{ path: "new.txt", index: "?" }]);
  expect(await fs.readFile(path.join(empty, "new.txt"), "utf8")).toBe("new text without newline");
}, 20000);

it("preserves CRLF, whitespace and missing final newline when staging and reversing a hunk", async () => {
  const base = original.trimEnd().replaceAll("\n", "\r\n");
  await write(base);
  await desktop.git(repo, ["add", "."]);
  await desktop.git(repo, ["commit", "-m", "CRLF base"]);
  const changed = base.replace("line 2\r\n", "space  \r\n").replace("line 32", "ending without newline");
  await write(changed);
  expect(gitHunks(await desktop.diff(repo, file))).toHaveLength(2);
  await change(false, 1);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(base.replace("line 32", "ending without newline"));
  await change(true, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(base);
  await change(false, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(base.replace("line 2\r\n", "space  \r\n"));
  expect(await fs.readFile(path.join(repo, file), "utf8")).toBe(changed);
}, 20000);

it("handles staged additions and working deletions without touching files on disk", async () => {
  await fs.writeFile(path.join(repo, "added.txt"), "new file\n");
  await desktop.git(repo, ["add", "added.txt"]);
  await change(true, 0, "added.txt");
  expect((await desktop.changes(repo)).files.find((entry) => entry.path === "added.txt")?.index).toBe("?");
  expect(await fs.readFile(path.join(repo, "added.txt"), "utf8")).toBe("new file\n");
  await fs.unlink(path.join(repo, file));
  await change(false, 0);
  expect((await desktop.changes(repo)).files.find((entry) => entry.path === file)?.index).toBe("D");
  await change(true, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original);
  await expect(fs.stat(path.join(repo, file))).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

it("rejects changed previews, invalid hunks and stale index snapshots without applying partial changes", async () => {
  await write(original.replace("line 2\n", "one\n").replace("line 29\n", "two\n"));
  const state = await desktop.changes(repo), diff = await desktop.diff(repo, file);
  for (const hunk of [-1, 2, 0.5])
    await expect(desktop.gitHunk(repo, file, false, hunk, state.revision, diff)).rejects.toThrow("整文件");
  await write(original.replace("line 2\n", "new work\n"));
  await expect(desktop.gitHunk(repo, file, false, 0, state.revision, diff)).rejects.toThrow("文件差异已变化");
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original);
  await desktop.git(repo, ["add", "."]);
  await expect(desktop.gitHunk(repo, file, false, 0, state.revision, diff)).rejects.toThrow("Git 状态已变化");
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original.replace("line 2\n", "new work\n"));
}, 20000);

it("rejects rename, binary, submodule, mode-change and multi-file patches instead of mutating metadata", async () => {
  await desktop.git(repo, ["mv", file, "renamed.txt"]);
  await fs.writeFile(path.join(repo, "renamed.txt"), original.replace("line 2", "changed"));
  await desktop.git(repo, ["add", "."]);
  const rename = await desktop.diff(repo, "renamed.txt", true);
  expect(gitHunks(rename)).toEqual([]);
  await expect(change(true, 0, "renamed.txt")).rejects.toThrow("整文件");
  await fs.writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  await desktop.git(repo, ["add", "binary.bin"]);
  expect(gitHunks(await desktop.diff(repo, "binary.bin", true))).toEqual([]);
  const text = "diff --git a/a b/a\nindex 1111111..2222222 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
  expect(gitHunks(text)).toHaveLength(1);
  expect(gitHunks(text + text)).toEqual([]);
  expect(gitHunks(text.replace("100644", "160000"))).toEqual([]);
  expect(gitHunks(text.replace("index", "old mode 100644\nnew mode 100755\nindex"))).toEqual([]);
  expect(gitHunks(text.replace("+new\n", ""))).toEqual([]);
  expect(gitHunkPatch(text, 0)).toBe(text);
}, 20000);

it("leaves the index untouched on a Git lock failure and succeeds after the external operation ends", async () => {
  const changed = original.replace("line 2\n", "first\n").replace("line 29\n", "second\n");
  await write(changed);
  const lock = path.join(repo, ".git", "index.lock");
  await fs.writeFile(lock, "owned test fixture lock");
  try { await expect(change(false, 0)).rejects.toThrow("index.lock"); }
  finally { await fs.unlink(lock); }
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original);
  expect(await fs.readFile(path.join(repo, file), "utf8")).toBe(changed);
  await change(false, 0);
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original.replace("line 2\n", "first\n"));
}, 20000);

it("keeps non-UTF-8 file bytes out of reconstructed text patches", async () => {
  const bytes = Buffer.concat([Buffer.from("line 1\n"), Buffer.from([0x81, 0x82]), Buffer.from("\nline 3\n")]);
  await fs.writeFile(path.join(repo, file), bytes);
  const state = await desktop.changes(repo), diff = await desktop.diff(repo, file);
  expect(diff).toContain("\uFFFD");
  expect(gitHunks(diff)).toEqual([]);
  await expect(desktop.gitHunk(repo, file, false, 0, state.revision, diff)).rejects.toThrow("整文件");
  expect(await desktop.git(repo, ["show", `:${file}`])).toBe(original);
  expect(await fs.readFile(path.join(repo, file))).toEqual(bytes);
}, 20000);
