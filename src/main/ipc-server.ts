import net from "node:net";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { atomicWrite } from "../core/store";
import type { Scheduler } from "../core/scheduler";
import { redact } from "../core/redact";
export function pipeName(root: string) {
  const key = createHash("sha256")
    .update(root.toLowerCase())
    .digest("hex")
    .slice(0, 20);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codex-relay-${key}`
    : path.join(root, "relay.sock");
}
export async function startCommandServer(
  root: string,
  scheduler: Scheduler,
  command: (name: string, args?: unknown) => Promise<unknown>,
) {
  const token = randomBytes(32).toString("hex");
  await atomicWrite(path.join(root, "ipc-token"), token);
  const endpoint = pipeName(root);
  if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    let authenticated = false;
    let watching = false;
    let pendingCommands = 0;
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => {
      if (!watching && pendingCommands === 0) socket.destroy();
    });
    const send = (value: unknown) => {
      if (!socket.destroyed) {
        if (socket.writableLength > 4 * 1024 * 1024) socket.destroy();
        else socket.write(JSON.stringify(value) + "\n");
      }
    };
    const snapshot = (data: unknown) => send({ event: "snapshot", data });
    socket.on("error", () => {});
    socket.on("close", () => scheduler.off("snapshot", snapshot));
    let chain = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        pendingCommands++;
        chain = chain.then(async () => {
          if (socket.destroyed) {
            pendingCommands--;
            return;
          }
          let msg: any;
          try {
            msg = JSON.parse(line);
            if (!authenticated) {
              const provided = Buffer.from(String(msg.token ?? ""));
              const expected = Buffer.from(token);
              if (
                provided.length !== expected.length ||
                !timingSafeEqual(provided, expected)
              ) {
                socket.destroy();
                return;
              }
              authenticated = true;
            }
            if (msg.command === "watch") {
              if (!watching) {
                watching = true;
                scheduler.on("snapshot", snapshot);
              }
              send({ id: msg.id, result: scheduler.snapshot() });
              return;
            }
            // File dialogs and OAuth browser opens belong to the desktop UI.
            if (
              ![
                "snapshot",
                "job.add",
                "job.control",
                "approval.respond",
              ].includes(msg.command)
            )
              throw new Error("CLI command not allowed");
            send({ id: msg.id, result: await command(msg.command, msg.args) });
          } catch (error) {
            send({
              id: msg?.id,
              error: redact(error instanceof Error ? error.message : error),
            });
          } finally {
            pendingCommands--;
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  return server;
}
