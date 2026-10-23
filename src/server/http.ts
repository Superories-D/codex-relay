import { prepareWorkspaces, resolveWorkspace } from "./workspaces";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { redact, redactValue } from "../core/redact";
import type { ServerRuntime } from "./runtime";
const allowed = new Set([
  "snapshot",
  "health",
  "settings.save",
  "job.submit",
  "job.control",
  "chat.send",
  "chat.submit",
  "chat.read",
  "approval.list",
  "approval.respond",
  "job.report",
  "workflow.add",
  "workflow.report",
  "scheduler.dispatch",
  "scheduler.projectLimit",
  "job.dependencies",
]);
export async function openHttp(
  runtime: ServerRuntime,
  port: number,
  workspaces: string[],
  uiDirectory?: string,
) {
  const roots = await prepareWorkspaces(runtime.store.root, workspaces);
  const tokenFile = path.join(runtime.store.root, "http-token");
  try {
    await fs.writeFile(tokenFile, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  const stat = await fs.lstat(tokenFile);
  if (!stat.isFile() || stat.mode & 0o077)
    throw Error("HTTP token must be an owner-only regular file");
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid HTTP token file");
  const workspace = (value: unknown) => resolveWorkspace(roots, value);
  let pendingCommands = 0;
  const streams = new Set<http.ServerResponse>();
  const send = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(redactValue(value)));
  };
  const snapshot = () => redactValue(runtime.scheduler.snapshot());
  const push = (res: http.ServerResponse) => {
    if (res.writableLength > 4 * 1024 * 1024) {
      res.destroy();
      return;
    }
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  };
  const publish = () => {
    for (const res of streams) push(res);
  };
  runtime.scheduler.on("snapshot", publish);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    let admitted = false;
    try {
      const host = req.headers.host;
      if (!host || !/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host))
        return send(res, 403, { error: "Invalid Host header" });
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        return send(res, 403, {
          error: "Cross-origin requests are not allowed",
        });
      if (
        req.method === "GET" &&
        uiDirectory &&
        ["/", "/app.js", "/app.css"].includes(req.url || "")
      ) {
        const file = req.url === "/" ? "index.html" : req.url!.slice(1);
        const content = await fs.readFile(path.join(uiDirectory, file));
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        res.writeHead(200, {
          "Content-Type": file.endsWith(".js")
            ? "application/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html; charset=utf-8",
        });
        res.end(content);
        return;
      }
      const presented = Buffer.from(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        ),
        expected = Buffer.from(token);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      )
        return send(res, 401, { error: "Authentication required" });
      if (req.method === "GET" && req.url === "/api/meta")
        return send(res, 200, {
          version: 1,
          workspaces: roots,
          commands: [...allowed],
        });
      if (req.method === "GET" && req.url === "/api/health")
        return send(res, 200, await runtime.command("health"));
      if (req.method === "GET" && req.url === "/api/snapshot")
        return send(res, 200, snapshot());
      if (req.method === "GET" && req.url === "/api/events") {
        if (streams.size >= 32)
          return send(res, 503, { error: "Too many status streams" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        streams.add(res);
        push(res);
        const heartbeat = setInterval(() => {
          if (res.writableLength > 4 * 1024 * 1024) res.destroy();
          else res.write(": heartbeat\n\n");
        }, 15000);
        heartbeat.unref();
        res.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(res);
        });
        return;
      }
      if (req.method !== "POST" || req.url !== "/api/command")
        return send(res, 404, { error: "Not found" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send(res, 415, { error: "JSON required" });
      if (pendingCommands >= 32)
        return send(res, 503, { error: "Too many commands in progress" });
      pendingCommands++;
      admitted = true;
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          send(res, 413, { error: "Request too large" });
          return;
        }
        chunks.push(chunk);
      }
      const body = z
        .object({ name: z.string(), args: z.unknown().optional() })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!allowed.has(body.name))
        return send(res, 403, { error: "Command is not exposed over HTTP" });
      const args: any = body.args;
      if (body.name === "job.submit") {
        if (!args?.input) throw Error("Task input is required");
        args.input.cwd = await workspace(args.input.cwd);
      }
      if (body.name === "workflow.add") {
        if (!Array.isArray(args?.steps) || args.steps.length > 12)
          throw Error("Invalid workflow stages");
        for (const step of args.steps) step.cwd = await workspace(step.cwd);
      }
      const attachments = ["job.submit", "chat.submit"].includes(body.name)
        ? args?.input?.attachments
        : body.name === "chat.send"
          ? args?.attachments
          : [];
      if (Array.isArray(attachments))
        for (const attachment of attachments)
          attachment.path = await workspace(attachment.path);
      return send(res, 200, {
        result: await runtime.command(body.name, body.args),
      });
    } catch (error) {
      if (!res.headersSent)
        send(res, 400, {
          error: redact(error instanceof Error ? error.message : error),
        });
      else res.destroy();
    } finally {
      if (admitted) pendingCommands--;
    }
  });
  server.maxConnections = 128;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("clientError", (_error, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    runtime.scheduler.off("snapshot", publish);
    throw error;
  }
  return {
    server,
    async close() {
      runtime.scheduler.off("snapshot", publish);
      for (const res of streams) res.end();
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
