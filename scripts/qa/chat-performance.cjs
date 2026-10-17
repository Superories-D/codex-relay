// Exercises large journals using production Chats; no credentials or inference.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { build } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const p95 = (values) =>
  values.sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
(async () => {
  await fs.mkdir(output, { recursive: true });
  const entry = path.join(output, "chat-performance-core.cjs");
  await build({
    entryPoints: [path.join(root, "src/core/chat.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const { Chats } = require(entry);
  const profile = await fs.mkdtemp(path.join(output, "chat-performance-")),
    chats = new Chats(profile),
    id = "journal";
  await fs.mkdir(path.dirname(chats.file(id)), { recursive: true });
  const rows = Array.from({ length: 10000 }, (_, i) =>
    JSON.stringify({
      id: String(i),
      role: "assistant",
      kind: "message",
      text: `Message ${i}\n` + "Context and code remain available. ".repeat(60),
      at: 1,
    }),
  );
  await fs.writeFile(chats.file(id), rows.join("\n") + "\n");
  const start = performance.now();
  const first = await chats.read(id);
  const coldMs = performance.now() - start;
  assert.equal(first.total, 10000);
  assert.equal(first.items.length, 80);
  const reads = [],
    appends = [];
  for (let n = 0; n < 40; n++) {
    let at = performance.now();
    await chats.read(id);
    reads.push(performance.now() - at);
    at = performance.now();
    await chats.user(id, "New message " + n);
    const page = await chats.read(id);
    appends.push(performance.now() - at);
    assert.equal(page.total, 10001 + n);
    assert.equal(page.items.at(-1).text, "New message " + n);
  }
  const report = {
    messages: 10000,
    journalMiB: (await fs.stat(chats.file(id))).size / 1048576,
    coldReadMs: coldMs,
    cachedReadP95Ms: p95(reads),
    appendAndReadP95Ms: p95(appends),
    appendedMessages: 40,
  };
  await fs.writeFile(
    path.join(output, "chat-performance-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
