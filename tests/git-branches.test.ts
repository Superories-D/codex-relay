import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { Desktop } from "../src/core/desktop";

let root: string, repo: string, desktop: Desktop;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-branches-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  desktop = new Desktop(path.join(root, "profile"));
  await desktop.git(repo, ["init", "-b", "main"]);
  await desktop.git(repo, ["config", "user.name", "Branch QA"]);
  await desktop.git(repo, ["config", "user.email", "qa@example.invalid"]);
  await desktop.git(repo, ["config", "core.autocrlf", "false"]);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const write = (text: string) => fs.writeFile(path.join(repo, "file.txt"), text);
const branch = async (ref: string, name?: string) =>
  desktop.switchBranch(repo, ref, (await desktop.branchList(repo)).head, name);
async function initial() {
  await write("base\n");
  await desktop.git(repo, ["add", "."]);
  await desktop.git(repo, ["commit", "-m", "initial"]);
}

it("creates Unicode branches before the first commit and from detached HEAD, preserving staged and working files", async () => {
  await write("staged\n");
  await desktop.git(repo, ["add", "."]);
  await write("working\n");
  expect((await branch("HEAD", "機能/未提交")).branch).toBe("機能/未提交");
  expect(await desktop.git(repo, ["show", ":file.txt"])).toBe("staged\n");
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe(
    "working\n",
  );
  await desktop.git(repo, ["commit", "-m", "initial"]);
  await desktop.git(repo, ["switch", "--detach"]);
  expect((await desktop.branchList(repo)).current).toBe("");
  expect((await branch("HEAD", "feature/detached")).branch).toBe(
    "feature/detached",
  );
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe(
    "working\n",
  );
}, 20000);

it("refuses overwriting dirty files and does not leave a new branch after failed checkout", async () => {
  await initial();
  await branch("HEAD", "target");
  await write("target\n");
  await desktop.git(repo, ["commit", "-am", "target"]);
  await branch("refs/heads/main");
  await write("local dirty\n");
  await expect(branch("refs/heads/target")).rejects.toThrow();
  await expect(branch("refs/heads/target", "must-not-exist")).rejects.toThrow();
  expect((await desktop.changes(repo)).branch).toBe("main");
  expect(
    (await desktop.branchList(repo)).branches.some(
      (b) => b.name === "must-not-exist",
    ),
  ).toBe(false);
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe(
    "local dirty\n",
  );
}, 20000);

it("tracks an exact remote ref, skips symbolic aliases, and respects other Worktrees", async () => {
  await initial();
  const remote = path.join(root, "remote.git");
  await desktop.git(root, ["init", "--bare", remote]);
  await desktop.git(repo, ["remote", "add", "origin", remote]);
  await desktop.git(repo, ["push", "origin", "HEAD:refs/heads/topic"]);
  await desktop.git(repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/topic",
  ]);
  expect(
    (await desktop.branchList(repo)).branches.map((b) => b.ref),
  ).not.toContain("refs/remotes/origin/HEAD");
  expect((await branch("refs/remotes/origin/topic", "topic")).branch).toBe(
    "topic",
  );
  expect(
    (
      await desktop.git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"])
    ).trim(),
  ).toBe("origin/topic");
  const other = path.join(root, "other");
  await desktop.git(repo, ["worktree", "add", other, "main"]);
  expect(
    (await desktop.branchList(repo)).branches
      .find((b) => b.name === "main")
      ?.worktree.replace(/\\/g, "/"),
  ).toBe(other.replace(/\\/g, "/"));
  await expect(branch("refs/heads/main")).rejects.toThrow();
  expect((await desktop.changes(repo)).branch).toBe("topic");
}, 20000);

it("rejects invalid, missing and stale branch operations, including simultaneous requests", async () => {
  await initial();
  const before = await desktop.branchList(repo);
  for (const name of ["-force", "HEAD", "bad..name", "@{-1}", " a "])
    await expect(branch("HEAD", name)).rejects.toThrow("新分支名称无效");
  await expect(branch("--detach")).rejects.toThrow("所选分支已不存在");
  const results = await Promise.allSettled([
    desktop.switchBranch(repo, "HEAD", before.head, "first"),
    desktop.switchBranch(repo, "HEAD", before.head, "second"),
  ]);
  // Canonical-root discovery is asynchronous; either concurrent request may
  // enter the Worktree queue first. Exactly one may mutate the reviewed HEAD.
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter((r) => r.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason.message).toContain(
    "当前分支或提交已变化",
  );
  const winner = results[0].status === "fulfilled" ? "first" : "second";
  const loser = winner === "first" ? "second" : "first";
  const current = await desktop.branchList(repo);
  expect(current.current).toBe(`refs/heads/${winner}`);
  expect(current.branches.map((b) => b.name)).toContain(winner);
  expect(current.branches.map((b) => b.name)).not.toContain(loser);
  expect(await fs.readFile(path.join(repo, "file.txt"), "utf8")).toBe("base\n");
  await desktop.git(repo, ["commit", "--allow-empty", "-m", "external commit"]);
  await expect(
    desktop.switchBranch(repo, "refs/heads/main", current.head),
  ).rejects.toThrow("当前分支或提交已变化");
}, 20000);
