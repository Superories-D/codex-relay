import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Desktop } from "../src/core/desktop";

let root: string, repo: string, desktop: Desktop;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-git-concurrency-"));
  repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "nested"), { recursive: true });
  desktop = new Desktop(path.join(root, "profile"));
  await desktop.git(repo, ["init", "-b", "main"]);
  await desktop.git(repo, ["config", "user.name", "Concurrent Git QA"]);
  await desktop.git(repo, ["config", "user.email", "qa@example.invalid"]);
  await desktop.git(repo, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repo, "file.txt"), "base\n");
  await desktop.git(repo, ["add", "."]);
  await desktop.git(repo, ["commit", "-m", "initial"]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const write = (text: string) => fs.writeFile(path.join(repo, "file.txt"), text);

it("serializes stage and branch switch through nested/junction paths while an independent worktree progresses", async () => {
  const other = await desktop.worktree(repo);
  const alias = path.join(root, "alias");
  await fs.symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
  await write("changed\n");
  const head = (await desktop.branchList(repo)).head;
  const run = desktop.git.bind(desktop), order: string[] = [];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(desktop, "git").mockImplementation(async (cwd, args) => {
    const isStage = args.includes("add") && args.includes("file.txt");
    if (isStage) { entered(); await gate; }
    if (args.includes("switch")) order.push("switch");
    const result = await run(cwd, args);
    if (isStage) order.push("staged");
    return result;
  });
  const staging = desktop.gitAction(path.join(repo, "nested"), "stage", "file.txt");
  await started;
  const switching = desktop.switchBranch(alias, "HEAD", head, "topic");
  // Observe rejection immediately, including when an assertion below fails.
  const settled = Promise.allSettled([staging, switching]);
  try {
    await fs.writeFile(path.join(other.cwd, "independent.txt"), "separate index\n");
    await desktop.gitAction(other.cwd, "stage", "independent.txt");
    await desktop.gitAction(other.cwd, "commit", undefined, "independent");
    expect((await run(other.cwd, ["log", "-1", "--format=%s"])).trim()).toBe("independent");
  } finally { release(); }
  expect((await settled).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(order).toEqual(["staged", "switch"]);
  expect(await run(repo, ["show", ":file.txt"])).toBe("changed\n");
}, 20000);

it("rejects committing a different staged blob even when porcelain status is unchanged", async () => {
  await write("reviewed\n");
  await desktop.gitAction(repo, "stage", "file.txt");
  const viewed = await desktop.changes(repo);
  await write("another task\n");
  await desktop.gitAction(repo, "stage", "file.txt");
  const changed = await desktop.changes(repo);
  expect(changed.files).toEqual(viewed.files);
  await expect(desktop.gitAction(repo, "commit", undefined, "must not commit", viewed.revision)).rejects.toThrow("Git 状态已变化");
  expect((await desktop.git(repo, ["log", "-1", "--format=%s"])).trim()).toBe("initial");
  expect(await desktop.git(repo, ["show", ":file.txt"])).toBe("another task\n");
  // A rejected operation must not poison the queue; a refreshed request works.
  await desktop.gitAction(repo, "commit", undefined, "reviewed again", changed.revision);
  expect((await desktop.git(repo, ["log", "-1", "--format=%s"])).trim()).toBe("reviewed again");
}, 20000);

it("rejects an old branch view for restore and push even when HEAD points to the same commit", async () => {
  await write("keep my work\n");
  const viewed = await desktop.changes(repo);
  await desktop.git(repo, ["switch", "-c", "other"]);
  for (const action of ["restore", "push"]) {
    await expect(desktop.gitAction(repo, action, "file.txt", undefined, viewed.revision)).rejects.toThrow("Git 状态已变化");
  }
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe("keep my work\n");
  expect((await desktop.changes(repo)).branch).toBe("other");
}, 20000);

it("allows only one concurrent commit from the same reviewed revision", async () => {
  await write("one commit\n");
  await desktop.gitAction(repo, "stage", "file.txt");
  const viewed = await desktop.changes(repo);
  const results = await Promise.allSettled([
    desktop.gitAction(repo, "commit", undefined, "first", viewed.revision),
    desktop.gitAction(repo, "commit", undefined, "second", viewed.revision),
  ]);
  // Canonical-path resolution may finish in either order before queue admission.
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason.message).toContain("Git 状态已变化");
  const winner = results.findIndex((r) => r.status === "fulfilled");
  expect((await desktop.git(repo, ["log", "-1", "--format=%s"])).trim()).toBe(["first", "second"][winner]);
  expect(await desktop.git(repo, ["show", "HEAD:file.txt"])).toBe("one commit\n");
  expect((await desktop.git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
}, 20000);

it("rejects staging or discarding text changed since preview even when status and index match", async () => {
  await write("reviewed working text\n");
  const viewed = await desktop.changes(repo);
  const diff = await desktop.diff(repo, "file.txt");
  await write("new work from another task\n");
  expect((await desktop.changes(repo)).revision).toBe(viewed.revision);
  for (const action of ["stage", "restore"]) {
    await expect(desktop.gitAction(repo, action, "file.txt", undefined, viewed.revision, diff))
      .rejects.toThrow("文件差异已变化");
  }
  expect(await desktop.git(repo, ["show", ":file.txt"])).toBe("base\n");
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe("new work from another task\n");
  await desktop.gitAction(repo, "stage", "file.txt", undefined, viewed.revision, await desktop.diff(repo, "file.txt"));
  expect(await desktop.git(repo, ["show", ":file.txt"])).toBe("new work from another task\n");
}, 20000);
