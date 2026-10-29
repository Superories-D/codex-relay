import http from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ServerRuntime } from "../src/server/runtime";
import { openHttp } from "../src/server/http";
const exec = promisify(execFile);
describe.skipIf(process.platform !== "linux")("remote CLI", () => {
  it("retries a lost creation response under one ID and deduplicates follow-up delivery", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-remote-cli-")),
      workspace = path.join(base, "work");
    await fs.mkdir(workspace);
    const runtime = await ServerRuntime.open(path.join(base, "data"));
    await runtime.scheduler.dispatch(true);
    const web = await openHttp(runtime, 0, [workspace]);
    const target = `http://127.0.0.1:${(web.server.address() as any).port}`;
    let dropped = false,
      requests = 0;
    const proxy = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const result = await fetch(target + req.url, {
        method: req.method,
        headers: {
          Authorization: req.headers.authorization!,
            ...(req.headers["x-relay-server-id"]?{"X-Relay-Server-ID":String(req.headers["x-relay-server-id"])}:{}),
          "Content-Type": "application/json",
        },
        body: body || undefined,
      });
      const text = await result.text();
      if (req.method === "POST" && JSON.parse(body).name === "job.submit") {
        requests++;
        if (!dropped) {
          dropped = true;
          res.destroy();
          return;
        }
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(text);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as any).port}`,
      tokenFile = path.join(runtime.store.root, "http-token");
    const cli = (args: string[]) =>
      exec(process.execPath, [
        "scripts/remote.cjs",
        ...args,
        "--url",
        url,
        "--token-file",
        tokenFile,
      ],{env:{...process.env,RELAY_REMOTE_HOME:path.join(base,"client")}});
    try {
      const output = await cli([
        "run",
        "--cwd",
        workspace,
        "--prompt",
        "Do it once",
        "--detach",
      ]);
      const created = JSON.parse(output.stdout);
      expect(requests).toBe(2);
      expect(runtime.store.data.jobs).toHaveLength(1);
      const again = await cli([
        "run",
        "--cwd",
        workspace,
        "--prompt",
        "Do it once",
        "--detach",
        "--request-id",
        created.requestId,
      ]);
      expect(JSON.parse(again.stdout).id).toBe(created.id);
      const sent = await cli([
        "send",
        "--id",
        created.id,
        "--prompt",
        "Follow up once",
      ]);
      const receipt = JSON.parse(sent.stdout);
      await cli([
        "send",
        "--id",
        created.id,
        "--prompt",
        "Follow up once",
        "--request-id",
        receipt.requestId,
      ]);
      expect(runtime.store.data.jobs[0].queuedMessages).toHaveLength(1);
      await cli(["pause", "--id", created.id]);
      await expect(
        exec(process.execPath, [
          "scripts/remote.cjs",
          "watch",
          "--id",
          created.id,
          "--url",
          target,
          "--token-file",
          tokenFile,
        ]),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      proxy.closeIdleConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await web.close();
      await runtime.close();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
  it("reconnects status streams through recovery without replaying any task command", async () => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "relay-remote-watch-"),
      ),
      file = path.join(root, "token");
    await fs.writeFile(file, "a".repeat(64),{mode:0o600});
    let connections = 0;
    const methods: string[] = [];
    const server = http.createServer((req, res) => {
      methods.push(req.method!);
      connections++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `event: snapshot\ndata: ${JSON.stringify({ approvals: [], jobs: [{ id: "job", state: connections === 1 ? "needs_attention" : "completed", autoRecovery: connections === 1 ? { attempt: 1, nextAttemptAt: Date.now() + 1000 } : undefined }] })}\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const output = await exec(process.execPath, [
        "scripts/remote.cjs",
        "watch",
        "--id",
        "job",
        "--url",
        `http://127.0.0.1:${(server.address() as any).port}`,
        "--token-file",
        file,
      ]);
      expect(output.stdout).toContain("needs_attention");
      expect(output.stdout).toContain("completed");
      expect(methods).toEqual(["GET", "GET"]);
    } finally {
      server.closeIdleConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
