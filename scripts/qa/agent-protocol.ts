// Real installed CLI, local protocol only: no login, no model turn, no quota use.
import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import { Rpc } from "../../src/core/rpc";
import { prepareThread } from "../../src/core/thread";
import { findTranscript } from "../../src/core/transcript";
import { Store } from "../../src/core/store";
import { Chats } from "../../src/core/chat";
import { History } from "../../src/core/history";
async function main() {
  const root = process.cwd();
  const output = await fs.mkdtemp(
    path.join(root, "qa-output", "agent-protocol-"),
  );
  const home = path.join(output, "source"),
    cwd = path.join(output, "project");
  await fs.mkdir(cwd, { recursive: true });
  const cli = path.join(
    root,
    "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  const config = {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "on-request",
    model: "gpt-6.1-sol",
  };
  let rpc: Rpc | undefined;
  try {
    rpc = await Rpc.open(cli, home);
    const started = await prepareThread(rpc, undefined, config);
    const sourceId = started.thread.id;
    const models = await rpc.call("model/list", { limit: 100 });
    assert.ok(models.data.length > 0);
    await rpc.close();
    rpc = undefined;
    const file = await findTranscript(home, sourceId, true),
      before = await fs.readFile(file);
    const store = new Store(path.join(output, "relay")),
      chats = new Chats(store.root),
      history = new History(store, chats);
    const scan = await history.scan([home]);
    assert.equal(scan.entries.length, 1);
    const imported = await history.import();
    assert.equal(imported.errors.length, 0);
    const job = store.data.jobs[0];
    assert.notEqual(job.threadId, sourceId);
    rpc = await Rpc.open(cli, store.jobHome(job.id));
    const resumed = await prepareThread(
      rpc,
      job.threadId,
      config,
      job.importedRollout,
    );
    assert.equal(resumed.thread.id, job.threadId);
    const read = await rpc.call("thread/read", {
      threadId: job.threadId,
      includeTurns: true,
    });
    assert.equal(read.thread.id, job.threadId);
    await rpc.close();
    rpc = undefined;
    assert.deepEqual(await fs.readFile(file), before);
    rpc = await Rpc.open(cli, store.jobHome(job.id));
    const reopened = await prepareThread(rpc, job.threadId, config);
    assert.equal(reopened.thread.id, job.threadId);
    await rpc.close();
    rpc = undefined;
    let localHistory: unknown;
    if (process.argv.includes("--scan-local")) {
      const local = await history.scan([path.join(os.homedir(), ".codex")]);
      const compatible = local.entries.find((e) => !e.issue);
      localHistory = {
        discovered: local.entries.length,
        warnings: local.warnings.length,
        sources: [...new Set(local.entries.map((e) => e.source))],
        compatibleSample: false,
      };
      if (compatible) {
        const imported = await history.import([compatible.id]);
        assert.equal(imported.errors.length, 0);
        const sample = store.data.jobs.find(
          (j) => j.id === imported.imported[0],
        )!;
        rpc = await Rpc.open(cli, store.jobHome(sample.id));
        await prepareThread(
          rpc,
          sample.threadId,
          config,
          sample.importedRollout,
        );
        const historyRead = await rpc.call("thread/read", {
          threadId: sample.threadId,
          includeTurns: true,
        });
        assert.equal(historyRead.thread.id, sample.threadId);
        const page = await chats.read(sample.id);
        assert.ok(page.total > 0);
        (localHistory as any).compatibleSample = true;
        (localHistory as any).messages = page.total;
        await rpc.close();
        rpc = undefined;
      }
    }
    const report = {
      cli: "0.162.1",
      authenticated: false,
      inferenceTurns: 0,
      checks: [
        "real app-server initialize",
        "model catalog",
        "durable thread creation",
        "full history scan",
        "independent imported thread",
        "resume by path",
        "read imported history",
        "resume again by id",
        "original rollout unchanged",
      ],
      localHistory,
      output,
    };
    await fs.writeFile(
      path.join(root, "qa-output/agent-protocol-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await rpc?.close();
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
