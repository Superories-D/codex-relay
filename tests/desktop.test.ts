import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Desktop, nextSchedule } from "../src/core/desktop";
let root: string, project: string, desktop: Desktop;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-"));
  project = path.join(root, "project");
  await fs.mkdir(project);
  desktop = new Desktop(path.join(root, "profile"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("previews and edits project files with conflict detection and rejects paths escaping through junctions", async () => {
  await fs.writeFile(path.join(project, "note.md"), "original");
  await fs.writeFile(path.join(root, "outside.txt"), "outside");
  const note = await desktop.read(project, "note.md");
  expect(note.kind).toBe("text");
  await expect(desktop.read(project, "../outside.txt")).rejects.toThrow("超出");
  await fs.symlink(
    root,
    path.join(project, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(desktop.read(project, "escape/outside.txt")).rejects.toThrow(
    "超出",
  );
  await expect(
    desktop.write(project, "note.md", "bad", note.mtime + 1),
  ).rejects.toThrow("已被其他程序修改");
  await desktop.write(project, "note.md", "updated", note.mtime);
  expect(await fs.readFile(path.join(project, "note.md"), "utf8")).toBe(
    "updated",
  );
});
it("runs real Git staging, commit, diff and independent worktree operations in a fixture repository", async () => {
  await desktop.git(project, ["init"]);
  await desktop.git(project, ["config", "user.email", "test@example.invalid"]);
  await desktop.git(project, ["config", "user.name", "Relay QA"]);
  await desktop.git(project, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(project, "file.txt"), "one\n");
  const state = await desktop.changes(project);
  expect(state.files[0]).toMatchObject({ path: "file.txt", index: "?" });
  await desktop.gitAction(project, "stage", "file.txt");
  await desktop.gitAction(project, "commit", undefined, "initial fixture");
  await fs.appendFile(path.join(project, "file.txt"), "two\n");
  expect(await desktop.diff(project, "file.txt")).toContain("+two");
  const copy = await desktop.worktree(project);
  expect(await fs.readFile(path.join(copy.cwd, "file.txt"), "utf8")).toBe(
    "one\n",
  );
  expect(await fs.readFile(path.join(project, "file.txt"), "utf8")).toContain(
    "two",
  );
  await desktop.git(project, ["worktree", "remove", copy.cwd]);
});
it("deduplicates persisted projects and computes future daily/weekly/interval runs in local time", async () => {
  expect((await desktop.project(project)).id).toBe(
    (await desktop.project(project)).id,
  );
  const restored = new Desktop(desktop.root);
  await restored.load();
  expect(restored.data.projects).toHaveLength(1);
  const now = new Date(2026, 9, 18, 12).getTime();
  const rule = {
    cadence: "daily" as const,
    hour: 9,
    minute: 30,
    weekday: 1,
    minutes: 60,
  };
  const daily = new Date(nextSchedule(rule, now));
  expect(daily.getDate()).toBe(19);
  expect(daily.getHours()).toBe(9);
  const weekly = new Date(nextSchedule({ ...rule, cadence: "weekly" }, now));
  expect(weekly.getDay()).toBe(1);
  expect(weekly.getTime()).toBeGreaterThan(now);
  expect(nextSchedule({ ...rule, cadence: "interval" }, now)).toBe(
    now + 3600000,
  );
});
