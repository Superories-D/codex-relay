import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Store } from "../src/core/store";
import { Desktop } from "../src/core/desktop";
import { BackgroundHistoryImport } from "../src/core/history-import";
import { importRunning } from "../src/shared/history-import";
import { Chats, jsonLines } from "../src/core/chat";
let suite: string,
  root: string,
  home: string,
  project: string,
  workerFile: string,
  store: Store,
  desktop: Desktop,
  importer: BackgroundHistoryImport;
beforeAll(async () => {
  suite = await fs.mkdtemp(path.join(os.tmpdir(), "relay-import-worker-"));
  workerFile = path.join(suite, "worker.cjs");
  await build({
    entryPoints: [path.resolve("src/core/history-import-worker.ts")],
    outfile: workerFile,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
});
afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(suite, "case-"));
  home = path.join(root, "source");
  project = path.join(root, "project");
  await fs.mkdir(project);
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  store = new Store(path.join(root, "app"));
  desktop = new Desktop(store.root);
  importer = new BackgroundHistoryImport(store, desktop, workerFile, () => {});
});
afterEach(async () => {
  await importer.shutdown();
});
it("imports records above 16 MiB without losing compacted context or complete tool output, while bounding the UI preview", async () => {
  const source = await fixture(1);
  const large = "x".repeat(17 * 1024 * 1024);
  await fs.appendFile(
    source.file,
    JSON.stringify({ type: "compacted", payload: { message: large } }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "large-output",
          output: large + "COMPLETE_TOOL_TAIL",
        },
      }) +
      "\n",
  );
  importer.start([home]);
  await finished();
  expect(importer.progress).toMatchObject({ imported: 1, failed: 0 });
  const job = store.data.jobs[0],
    page = await new Chats(store.root).read(job.id);
  expect(page.items.at(-1)?.sourceTruncated).toBe(true);
  expect(page.items.at(-1)?.detail?.length).toBeLessThan(300000);
  let found = false,
    compacted = false;
  for await (const row of jsonLines(
    job.importedRollout!,
    undefined,
    128 * 1024 * 1024,
  )) {
    if (row.type === "compacted")
      compacted = row.payload.message.length === large.length;
    if (row.payload?.type === "custom_tool_call_output")
      found = row.payload.output.endsWith("COMPLETE_TOOL_TAIL");
  }
  expect(found && compacted).toBe(true);
}, 30000);
async function fixture(index: number, extra: any = {}, archived = false) {
  const id = randomUUID(),
    dir = path.join(home, archived ? "archived_sessions" : "sessions");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const rows = [
    {
      timestamp: "2026-10-18T00:00:00Z",
      type: "session_meta",
      payload: {
        id,
        cwd: project,
        source: index % 2 ? "vscode" : "cli",
        ...extra,
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: `Chat ${index}` },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Question ${index}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Answer ${index}` }],
      },
    },
  ];
  await fs.writeFile(
    file,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  return { id, file };
}
async function finished() {
  const end = Date.now() + 20000;
  while (importRunning(importer.progress.phase) && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(importer.progress.phase, JSON.stringify(importer.progress)).toBe(
    "completed",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
}
it("imports Desktop projects without chats, CLI/archived chats and bounded parent history in a worker; repeated clicks deduplicate", async () => {
  const parent = await fixture(1),
    prefix = (await fs.stat(parent.file)).size;
  await fs.appendFile(
    parent.file,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "FUTURE_OUTSIDE_FORK" }],
      },
    }) + "\n",
  );
  const before = await fs.readFile(parent.file);
  await fixture(
    2,
    {
      history_base: {
        thread_id: parent.id,
        end_ordinal_exclusive: 4,
        end_byte_offset: prefix,
      },
    },
    true,
  );
  const orphanProject = path.join(root, "orphan-project");
  await fs.mkdir(orphanProject);
  await fs.writeFile(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {
        saved: { name: "Named Desktop project", rootPaths: [orphanProject] },
      },
      "electron-saved-workspace-roots": [path.join(root, "missing-folder")],
    }),
  );
  const started = importer.start([home]);
  expect(importer.start([home]).id).toBe(started.id);
  store.data.settings.pollSeconds = 45;
  await store.save();
  await finished();
  expect(importer.progress).toMatchObject({
    imported: 2,
    projects: 3,
    missingProjects: 1,
    failed: 0,
    readOnly: 0,
  });
  expect(desktop.data.projects.find((p) => p.cwd === orphanProject)?.name).toBe(
    "Named Desktop project",
  );
  expect(store.data.settings.pollSeconds).toBe(45);
  const fork = store.data.jobs.find((job) => job.archived)!;
  expect(fork.historySource?.issue).toBeUndefined();
  expect(
    (await new Chats(store.root).read(fork.id)).items.map((item) => item.text),
  ).toEqual(["Question 1", "Answer 1", "Question 2", "Answer 2"]);
  const rows = [];
  for await (const row of jsonLines(fork.importedRollout!)) rows.push(row);
  expect(rows[0].timestamp).toBe("2026-10-18T00:00:00Z");
  expect(rows[0].payload.history_base).toBeUndefined();
  expect(rows[0].payload.id).toBe(fork.threadId);
  expect(await fs.readFile(parent.file)).toEqual(before);
  importer.start([home]);
  await finished();
  expect(importer.progress).toMatchObject({
    imported: 0,
    skipped: 2,
    projects: 0,
  });
  expect(store.data.jobs).toHaveLength(2);
  const reloaded = new Store(store.root);
  await reloaded.load();
  expect(reloaded.data.jobs).toHaveLength(2);
}, 30000);
it("keeps unresolved ancestors and Desktop private tools readable with explicit compatibility reasons", async () => {
  await fixture(1, {
    history_base: {
      thread_id: randomUUID(),
      end_ordinal_exclusive: 5,
      end_byte_offset: 100,
    },
  });
  await fixture(2, { dynamic_tools: [{ name: "private-desktop-tool" }] });
  importer.start([home]);
  await finished();
  expect(importer.progress).toMatchObject({
    imported: 2,
    readOnly: 2,
    failed: 0,
  });
  expect(store.data.jobs.every((job) => !!job.historySource?.issue)).toBe(true);
  expect(
    store.data.jobs.some((job) => job.historySource?.issue?.includes("父会话")),
  ).toBe(true);
}, 30000);
it("cancels background work and permits a later deduplicated restart without changing source files", async () => {
  await Promise.all(Array.from({ length: 80 }, (_, i) => fixture(i)));
  importer.start([home]);
  importer.cancel();
  const end = Date.now() + 10000;
  while (importRunning(importer.progress.phase) && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(importer.progress.phase).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 50));
  importer.start([home]);
  await finished();
  expect(store.data.jobs).toHaveLength(80);
  expect((await fs.readdir(path.join(home, "sessions"))).length).toBe(80);
}, 30000);
