import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ServerRuntime } from "../src/server/runtime";
import { openHttp } from "../src/server/http";
import { Store } from "../src/core/store";

describe.skipIf(process.platform !== "linux")("authenticated bulk priority command", () => {
  it("routes a validated batch through the real runtime, persists eligible tasks and rejects unauthenticated and invalid requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-http-priority-"));
    const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
    const runtime = await ServerRuntime.open(path.join(root, "data"));
    await runtime.scheduler.dispatch(true);
    const web = await openHttp(runtime, 0, [workspace]);
    try {
      const base = `http://127.0.0.1:${(web.server.address() as any).port}`;
      const token = await fs.readFile(path.join(runtime.store.root, "http-token"), "utf8");
      const request = (name: string, args: unknown, authenticated = true) => fetch(base + "/api/command", {
        method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ name, args }),
      });
      const input = { title: "Priority flow", prompt: "Synthetic", cwd: workspace, mode: "cli", model: "", effort: "", bucket: "codex", approvalPolicy: "on-request", sandbox: "workspaceWrite" };
      const submitted = await request("job.submit", { requestId: randomUUID(), input });
      expect(submitted.status).toBe(200);
      const { result: job } = await submitted.json();
      const missing = randomUUID();
      expect((await request("jobs.priority", { ids: [job.id], priority: "high" }, false)).status).toBe(401);
      expect((await request("jobs.priority", { ids: [job.id], priority: "urgent" })).status).toBeGreaterThanOrEqual(400);
      const updated = await request("jobs.priority", { ids: [job.id, missing], priority: "high" });
      expect(updated.status).toBe(200);
      const { result } = await updated.json();
      expect(result.results).toMatchObject([{ id: job.id, ok: true }, { id: missing, ok: false, code: "missing" }]);
      const disk = new Store(runtime.store.root); await disk.load();
      expect(disk.data.jobs.find(item => item.id === job.id)?.priority).toBe("high");
    } finally { await web.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
