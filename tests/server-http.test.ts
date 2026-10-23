import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ServerRuntime } from "../src/server/runtime";
import { openHttp } from "../src/server/http";
describe.skipIf(process.platform !== "linux")(
  "authenticated HTTP service",
  () => {
    it("enforces authentication, origin, command and workspace boundaries and deduplicates submissions", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-http-"));
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace);
      const runtime = await ServerRuntime.open(path.join(root, "data"));
      await runtime.scheduler.dispatch(true);
      const web = await openHttp(runtime, 0, [workspace]);
      const base = `http://127.0.0.1:${(web.server.address() as any).port}`;
      const token = await fs.readFile(
        path.join(runtime.store.root, "http-token"),
        "utf8",
      );
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const command = (name: string, args?: unknown) =>
        fetch(base + "/api/command", {
          method: "POST",
          headers,
          body: JSON.stringify({ name, args }),
        });
      try {
        expect((await fetch(base + "/api/snapshot")).status).toBe(401);
        expect(
          (await fetch(base + "/api/snapshot?token=" + token)).status,
        ).toBe(401);
        expect(
          (
            await fetch(base + "/api/snapshot", {
              headers: { ...headers, Origin: "https://attacker.test" },
            })
          ).status,
        ).toBe(403);
        expect(
          await new Promise<number | undefined>((resolve, reject) => {
            const req = http.get(
              base + "/api/snapshot",
              { headers: { ...headers, Host: "attacker.test" } },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            );
            req.on("error", reject);
          }),
        ).toBe(403);
        expect(
          (await command("account.importText", { text: "secret" })).status,
        ).toBe(403);
        await expect(openHttp(runtime, 0, [root])).rejects.toThrow("overlap");
        const request = {
          requestId: randomUUID(),
          input: {
            title: "Remote",
            prompt: "Implement",
            cwd: workspace,
            mode: "cli",
            model: "",
            effort: "",
            bucket: "codex",
            sandbox: "workspaceWrite",
            approvalPolicy: "on-request",
          },
        };
        const [a, b] = await Promise.all([
          command("job.submit", request),
          command("job.submit", request),
        ]);
        const first: any = await a.json(),
          second: any = await b.json();
        expect(first.result.id).toBe(second.result.id);
        expect(runtime.store.data.jobs).toHaveLength(1);
        const changed = structuredClone(request);
        changed.input.prompt = "Changed";
        expect((await command("job.submit", changed)).status).toBe(400);
        const outside = structuredClone(request);
        outside.requestId = randomUUID();
        outside.input.cwd = root;
        expect((await command("job.submit", outside)).status).toBe(400);
        await fs.symlink(root, path.join(workspace, "escape"));
        outside.input.cwd = path.join(workspace, "escape");
        expect((await command("job.submit", outside)).status).toBe(400);
        const report: any = await (
          await command("job.report", first.result.id)
        ).json();
        expect(report.result.task.id).toBe(first.result.id);
      } finally {
        await web.close();
        await runtime.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    it("streams current snapshots and detaches listeners on shutdown", async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "relay-http-events-"),
      );
      const runtime = await ServerRuntime.open(root);
      const web = await openHttp(runtime, 0, []);
      const base = `http://127.0.0.1:${(web.server.address() as any).port}`,
        token = await fs.readFile(
          path.join(runtime.store.root, "http-token"),
          "utf8",
        );
      const controller = new AbortController();
      try {
        const response = await fetch(base + "/api/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain(
          "event: snapshot",
        );
        await runtime.scheduler.dispatch(true);
        const second = await reader.read();
        expect(new TextDecoder().decode(second.value)).toContain(
          '"paused":true',
        );
        controller.abort();
        await reader.cancel().catch(() => {});
      } finally {
        controller.abort();
        await web.close();
        expect(runtime.scheduler.listenerCount("snapshot")).toBe(0);
        await runtime.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  },
);

it.skipIf(process.platform !== "linux")("reports draining readiness and rejects new work with retryable status",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-drain-"));const runtime=await ServerRuntime.open(root);const web=await openHttp(runtime,0,[]);
 try{
 const base=`http://127.0.0.1:${(web.server.address() as any).port}`,token=await fs.readFile(path.join(root,"http-token"),"utf8"),headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
 expect((await fetch(base+"/api/health",{headers})).status).toBe(200);
 runtime.beginDrain();
 const health=await fetch(base+"/api/health",{headers});expect(health.status).toBe(503);expect((await health.json()).status).toBe("stopping");
 const response=await fetch(base+"/api/command",{method:"POST",headers,body:JSON.stringify({name:"snapshot"})});expect(response.status).toBe(503);expect(response.headers.get("retry-after")).toBe("5");
 await expect(runtime.command("job.add",{})).rejects.toMatchObject({status:503});expect(runtime.store.data.jobs).toHaveLength(0);
 }finally{await web.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});
