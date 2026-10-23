import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ServerRuntime } from "../src/server/runtime";
import { openHttp } from "../src/server/http";
it.skipIf(process.platform !== "linux")(
  "authenticates streamed uploads, recovers receipts and rejects private-file attachment forgery",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upload-http-")),
      workspace = path.join(root, "work");
    await fs.mkdir(workspace);
    const runtime = await ServerRuntime.open(path.join(root, "data"));
    await runtime.scheduler.dispatch(true);
    const web = await openHttp(runtime, 0, [workspace]);
    try {
      const base = `http://127.0.0.1:${(web.server.address() as any).port}`,
        token = await fs.readFile(
          path.join(runtime.store.root, "http-token"),
          "utf8",
        ),
        id = randomUUID(),
        endpoint = base + `/api/uploads/${id}?name=log.txt`,
        headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        };
      expect(
        (await fetch(endpoint, { method: "POST", body: "private" })).status,
      ).toBe(401);
      const uploads = await Promise.all([
        fetch(endpoint, { method: "POST", headers, body: "data-one" }),
        fetch(endpoint, { method: "POST", headers, body: "data-two" }),
      ]);
      expect(uploads.map((r) => r.status).sort()).toEqual([200, 400]);
      const stored = await (
        await fetch(base + `/api/uploads/${id}`, { headers })
      ).json();
      const input = {
        title: "Read uploaded",
        prompt: "Use log",
        cwd: workspace,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
        interactive: true,
        attachments: [stored.result.attachment],
      };
      const submit = async (attachment: any) =>
        fetch(base + "/api/command", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "job.submit",
            args: {
              requestId: randomUUID(),
              input: { ...input, attachments: [attachment] },
            },
          }),
        });
      expect((await submit(stored.result.attachment)).status).toBe(200);
      expect(
        (
          await submit({
            ...stored.result.attachment,
            path: path.join(runtime.store.root, "state.json"),
          })
        ).status,
      ).toBe(400);
      expect(
        (await submit({ ...stored.result.attachment, type: "localImage" }))
          .status,
      ).toBe(400);
      expect(runtime.store.data.jobs).toHaveLength(1);
    } finally {
      await web.close();
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
