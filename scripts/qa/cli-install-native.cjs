// Real official download/install in an isolated managed runtime. No accounts,
// login, model turns or changes to the user's existing Codex installation.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
function userPath(value) {
  return execFileSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      value === undefined
        ? '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); [Console]::Out.Write([Environment]::GetEnvironmentVariable("Path","User"))'
        : '[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); [Environment]::SetEnvironmentVariable("Path",[Console]::In.ReadToEnd(),"User")',
    ],
    { encoding: "utf8", windowsHide: true, input: value, timeout: 15000 },
  );
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const moduleFile = path.join(output, "cli-setup-core.cjs");
  buildSync({
    entryPoints: [path.join(root, "src/core/cli-setup.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: moduleFile,
  });
  const { CliSetup, probeCli, installManagedCli } = require(moduleFile);
  const fixture = await fs.mkdtemp(path.join(output, "cli-install-native-"));
  const before = process.platform === "win32" ? userPath() : undefined;
  let configured = path.join(fixture, "missing-codex"),
    installs = 0;
  const report = { fixture, modelRequests: 0, phases: [], downloads: 0 };
  const setup = new CliSetup(
    {
      root: fixture,
      configured: () => configured,
      select: async (cli) => {
        configured = cli;
        await fs.writeFile(
          path.join(fixture, "selected-cli.json"),
          JSON.stringify({ cli }),
        );
      },
      changed: (state) => {
        report.phases.push(state.phase);
        console.log(`CLI setup: ${state.phase}`);
      },
    },
    {
      // Simulate a fresh device without uninstalling or executing any user CLI.
      probe: async (cli) => {
        if (!cli.startsWith(path.join(fixture, "runtime")))
          throw Error("simulated missing installation");
        return probeCli(cli);
      },
      candidates: () => [],
      install: async (...args) => {
        installs++;
        return installManagedCli(...args);
      },
    },
  );
  try {
    const first = await setup.ensure();
    assert.equal(first.phase, "ready", first.error);
    assert.ok(first.path.startsWith(fixture));
    assert.match(first.version, /^codex-cli /);
    const second = await setup.ensure();
    assert.equal(second.phase, "ready");
    assert.equal(installs, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture, "selected-cli.json")))
        .cli,
      first.path,
    );
    report.downloads = installs;
    report.version = first.version;
    report.status = "passed";
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    await setup.shutdown();
    if (process.platform === "win32") {
      // The official installer exposes its command in the user PATH. Remove
      // only this test's unique bin entry, retaining concurrent unrelated edits.
      const bin = path.join(fixture, "runtime", "managed-cli", "bin");
      const after = userPath();
      if (after !== before) {
        const restored = after
          .split(";")
          .filter((entry) => entry.toLowerCase() !== bin.toLowerCase())
          .join(";");
        userPath(restored);
        report.pathRestored = userPath() === before;
      } else report.pathRestored = true;
    }
    await fs.writeFile(
      path.join(output, "cli-install-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
