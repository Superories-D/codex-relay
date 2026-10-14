import net from "node:net";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter, once } from "node:events";
import readline from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { startCommandServer, pipeName } from "../src/main/ipc-server";

// This Linux container denies AF_UNIX sockets. Exercise the actual JSONL protocol
// over a test-only loopback transport; Windows named pipes remain an acceptance check.
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  const actualNet = (actual as any).default ?? actual;
  return {
    ...actual,
    default: {
      ...actualNet,
      createServer: (...args: any[]) => {
        const server = (actualNet.createServer as any)(...args) as net.Server;
        const listen = server.listen.bind(server);
        server.listen = ((_endpoint: string, callback?: () => void) =>
          listen(0, "127.0.0.1", callback)) as typeof server.listen;
        return server;
      },
    },
  };
});
const originalChmod = fs.chmod.bind(fs);
vi.spyOn(fs, "chmod").mockImplementation((file, mode) =>
  String(file).endsWith("relay.sock")
    ? Promise.resolve()
    : originalChmod(file, mode),
);
afterEach(() => vi.clearAllMocks());
const portOf = (server: net.Server) =>
  (server.address() as net.AddressInfo).port;
const cleanup = async (server: net.Server, root: string) => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
};

it("CLI watch reports a lost supervisor connection as non-success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-ipc-"));
  await fs.writeFile(path.join(root, "ipc-token"), "synthetic");
  const server = net.createServer((socket) =>
    socket.once("data", () => socket.end()),
  );
  server.listen(pipeName(root));
  await once(server, "listening");
  try {
    const child = spawn(
      process.execPath,
      [
        "--require",
        path.join(process.cwd(), "tests/fixtures/pipe-over-tcp.cjs"),
        path.join(process.cwd(), "scripts/relay.cjs"),
        "watch",
        "--id",
        "job",
        "--data-dir",
        root,
      ],
      {
        env: { ...process.env, RELAY_TEST_PORT: String(portOf(server)) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    expect(code).toBe(1);
    expect(stderr).toContain("不能视为任务完成");
  } finally {
    await cleanup(server, root);
  }
});

it("local command server rejects wrong authentication and sends watch updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-ipc-"));
  const fake: any = new EventEmitter();
  fake.snapshot = () => ({ jobs: [], logs: [], approvals: [] });
  let calls = 0;
  const server = await startCommandServer(root, fake, async () => {
    calls++;
    return { ok: true };
  });
  const sockets: net.Socket[] = [];
  const connect = () => {
    const socket = net.createConnection({
      port: portOf(server),
      host: "127.0.0.1",
    });
    sockets.push(socket);
    return socket;
  };
  try {
    const bad = connect();
    bad.write(
      JSON.stringify({ token: "wrong", id: 1, command: "snapshot" }) + "\n",
    );
    await once(bad, "close");
    expect(calls).toBe(0);
    const good = connect();
    const lines = readline.createInterface({ input: good });
    const token = await fs.readFile(path.join(root, "ipc-token"), "utf8");
    const first = once(lines, "line");
    good.write(JSON.stringify({ token, id: 2, command: "watch" }) + "\n");
    expect(JSON.parse((await first)[0]).result.jobs).toEqual([]);
    const next = once(lines, "line");
    fake.emit("snapshot", { jobs: [{ state: "waiting" }] });
    expect(JSON.parse((await next)[0]).data.jobs[0].state).toBe("waiting");
    good.destroy();
    await once(good, "close");
    // The peer close is observed on a later event-loop turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.listenerCount("snapshot")).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await cleanup(server, root);
  }
});

it("disconnects a pipelined command flood instead of growing an unbounded promise queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-ipc-flood-"));
  const fake: any = new EventEmitter();
  fake.snapshot = () => ({ jobs: [] });
  const command = vi.fn(async () => ({}));
  const server = await startCommandServer(root, fake, command);
  const socket = net.createConnection({
    port: portOf(server),
    host: "127.0.0.1",
  });
  socket.on("error", () => {});
  try {
    const token = await fs.readFile(path.join(root, "ipc-token"), "utf8");
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    socket.write(
      Array.from(
        { length: 100 },
        (_, id) => JSON.stringify({ token, id, command: "snapshot" }) + "\n",
      ).join(""),
    );
    await closed;
    expect(command).not.toHaveBeenCalled();
  } finally {
    socket.destroy();
    await cleanup(server, root);
  }
});
