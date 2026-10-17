// Probe only uniquely named, synthetic files in the existing default home.
// Compare committed baseline with current writer; never touch app state/token.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { execFileSync } = require("node:child_process"),
  { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const home = path.join(process.env.APPDATA, "Codex Relay");
  assert((await fs.stat(home)).isDirectory());
  const baseline = path.join(output, "atomic-baseline.cjs"),
    fixed = path.join(output, "atomic-current.cjs");
  buildSync({
    stdin: {
      contents: execFileSync("git", ["show", "e316763:src/core/store.ts"], {
        cwd: root,
        encoding: "utf8",
      }),
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: baseline,
  });
  buildSync({
    stdin: {
      contents: 'export { atomicWrite } from "./src/core/store";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: fixed,
  });
  const report = {
    home,
    baselineCommit: "e316763",
    inferenceRequests: 0,
    cases: [],
  };
  for (const [mode, helper] of [
    ["baseline", baseline],
    ["fixed", fixed],
  ]) {
    const name = "qa-atomic-" + randomUUID() + ".json",
      file = path.join(home, name);
    let physical;
    const row = { mode, startedAt: Date.now() };
    try {
      const { atomicWrite } = require(helper);
      for (let revision = 1; revision <= 2; revision++) {
        await atomicWrite(file, JSON.stringify({ revision }));
        assert.equal(
          JSON.parse(await fs.readFile(file, "utf8")).revision,
          revision,
        );
      }
      physical = await fs.realpath(file);
      row.physicalParent = path.dirname(physical);
      row.status = "passed";
    } catch (error) {
      row.status = "failed";
      row.code = error.code;
      row.error = error.message;
      if (mode === "fixed") throw error;
    } finally {
      if (physical) await fs.rm(physical, { force: true });
      else await fs.rm(file, { force: true });
    }
    row.elapsedMs = Date.now() - row.startedAt;
    report.cases.push(row);
  }
  report.status = "passed";
  await fs.writeFile(
    path.join(output, "appdata-atomic-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
