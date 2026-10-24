import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
it("runs remote help and a profile tunnel from only declared Windows resources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-package-"));
  const resources = path.join(root, "resources");
  const client = path.join(root, "client");
  try {
    await fs.mkdir(resources);
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
    for (const resource of pkg.build.extraResources) {
      await fs.cp(resource.from, path.join(resources, resource.to), { recursive: true });
    }
    const run = (file: string, args: string[] = []) => exec(process.execPath,
      [path.join(resources, file), ...args],
      { cwd: root, env: { ...process.env, RELAY_REMOTE_HOME: client }, windowsHide: true, timeout: 20000 });
    expect((await run("remote.cjs")).stdout).toContain("Codex Relay remote CLI");
    await run("remote.cjs", ["init"]);
    const token = path.join(client, "credentials", "synthetic-token");
    await fs.writeFile(token, "a".repeat(64), { mode: 0o600 });
    await run("remote.cjs", ["profile", "save", "test", "--url", "http://127.0.0.1:7899",
      "--token-file", token, "--host", "user@example.test"]);
    const check = JSON.parse((await run("remote-tunnel.cjs", ["--profile", "test", "--check"])).stdout);
    expect(check.args).toContain("user@example.test");
    expect(check.args).toContain("StrictHostKeyChecking=yes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
