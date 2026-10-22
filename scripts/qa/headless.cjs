// Real bundled daemon + CLI, synthetic tasks only, no accounts or model calls.
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  net = require("node:net"),
  assert = require("node:assert/strict");
const exec = promisify(execFile);
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-daemon-qa-"));
  let child;
  async function start() {
    child = spawn(
      process.execPath,
      ["dist/server/main.cjs", "--data-dir", root, "--ipc-port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stderr.on("data", (d) => {
      output += d;
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(output || "daemon start timeout")),
        10000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(output));
      });
      child.stdout.on("data", (d) => {
        output += d;
        const match = output.match(/IPC TCP port: (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
  }
  async function stop() {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await done;
    assert.equal(code, 0);
    child = undefined;
  }
  async function command(port, name, args) {
    const token = await fs.readFile(path.join(root, "ipc-token"), "utf8");
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let buffer = "";
      socket.setTimeout(5000, () => socket.destroy(Error("IPC timeout")));
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({ id: 1, token, command: name, args }) + "\n",
        ),
      );
      socket.on("data", (d) => {
        buffer += d;
        if (buffer.includes("\n")) {
          socket.end();
          const result = JSON.parse(buffer.split("\n")[0]);
          result.error ? reject(Error(result.error)) : resolve(result.result);
        }
      });
    });
  }
  try {
    let port = await start();
    const status = await exec(process.execPath, [
      "scripts/relay.cjs",
      "status",
      "--json",
      "--data-dir",
      root,
      "--ipc-port",
      String(port),
    ]);
    assert.deepEqual(JSON.parse(status.stdout).tasks, []);
    await assert.rejects(
      exec(process.execPath, [
        "dist/server/main.cjs",
        "--data-dir",
        root,
        "--check",
      ]),
      /already owned/,
    );
    const job = await command(port, "job.add", {
      title: "Daemon smoke",
      prompt: "Synthetic queued task",
      cwd: root,
      mode: "cli",
      model: "",
      effort: "",
      bucket: "codex",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    });
    assert.ok(job.id);
    await stop();
    port = await start();
    const snap = await command(port, "snapshot");
    assert.equal(snap.jobs[0].id, job.id);
    assert.ok(["queued", "waiting"].includes(snap.jobs[0].state));
    await stop();
    console.log(
      "PASS: bundled headless daemon, authenticated CLI, singleton ownership, task persistence and restart; zero model calls",
    );
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
