import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import http from "node:http";
import { ServerRuntime } from "../src/server/runtime";
import { openHttp } from "../src/server/http";
const { RemoteStore, endpoint } = createRequire(import.meta.url)(
    "../scripts/remote-store.cjs",
  ),
  exec = promisify(execFile);
it.each(["task.control","task.queue","delivery.save","delivery.run","schedule.abandon"])("retains %s for recovery after an ambiguous response",async name=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-command-recovery-")),serverId=randomUUID(),id=randomUUID(),requests:any[]=[];
  const server=http.createServer(async(req,res)=>{
    res.setHeader("Content-Type","application/json");
    if(req.url==="/api/meta"){res.end(JSON.stringify({serverId}));return;}
    let body="";for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    if(requests.length===1){res.writeHead(409);res.end(JSON.stringify({error:"Acknowledgment lost after acceptance"}));}
    else res.end(JSON.stringify({result:{id,state:"succeeded",result:{applied:true}}}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const token=path.join(root,"token"),command=path.join(root,"command.json"),url=`http://127.0.0.1:${(server.address() as any).port}`,env={...process.env,RELAY_REMOTE_HOME:path.join(root,"client")};
    const payload={name,args:{requestId:id,id:randomUUID(),input:{text:"Original frozen input"}}};
    await fs.writeFile(token,"a".repeat(64),{mode:0o600});await fs.writeFile(command,JSON.stringify(payload));
    const run=(args:string[])=>exec(process.execPath,["scripts/remote.cjs",...args,"--url",url,"--token-file",token],{env});
    await expect(run(["command","--file",command])).rejects.toThrow("Acknowledgment lost");
    const store=new RemoteStore(env.RELAY_REMOTE_HOME);expect(store.read(id)).toMatchObject({state:"pending",serverId,name,args:payload.args});
    await run(["recover","--request-id",id]);expect(store.read(id).state).toBe("confirmed");expect(requests).toEqual([payload,payload]);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await fs.rm(root,{recursive:true,force:true});}
});
it("stores private profiles and binds immutable requests to server identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-profiles-"));
  try {
    const store = new RemoteStore(path.join(root, "client")),
      tokenFile = path.join(store.root, "credentials", "import-token");
    await fs.writeFile(tokenFile, "a".repeat(64), { mode: 0o600 });
    store.saveProfile("linux-server", {
      url: "http://127.0.0.1:7899",
      tokenFile,
      cwd: "/server/project",
    });
    expect(store.profile("linux-server").cwd).toBe("/server/project");
    expect(JSON.stringify(store.profiles())).not.toContain("a".repeat(64));
    const args = { requestId: randomUUID(), input: { prompt: "私有任务" } },
      serverId = randomUUID();
    const pending = store.begin(
      "http://127.0.0.1:7899",
      serverId,
      "job.submit",
      args,
    );
    expect(new RemoteStore(store.root).read(args.requestId)).toEqual(pending);
    expect(() =>
      store.begin("http://127.0.0.1:7899", randomUUID(), "job.submit", args),
    ).toThrow("different");
    expect(() =>
      store.begin("http://127.0.0.1:7899", serverId, "job.submit", {
        ...args,
        input: { prompt: "changed" },
      }),
    ).toThrow("different");
    store.finish(pending, { id: "created" });
    expect(store.read(args.requestId).state).toBe("confirmed");
    expect(JSON.stringify(store.requests())).not.toContain("私有任务");
    for (const value of [
      "http://remote.example",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
    ])
      expect(() => endpoint(value)).toThrow();
    expect(() => store.profile("../escape")).toThrow();
    store.removeProfile("linux-server");
    expect(store.profiles()).toHaveLength(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
// Windows launches real PowerShell ACL checks for each private read and root.
// Keep every permission/identity assertion; allow bounded native-process overhead.
}, process.platform === "win32" ? 20000 : 5000);
it.skipIf(process.platform !== "linux")(
  "recovers an accepted request after the client is killed and rejects a different installation behind the same tunnel",
  async () => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "relay-client-recover-"),
      ),
      work = path.join(root, "work");
    await fs.mkdir(work);
    const runtime = await ServerRuntime.open(path.join(root, "data"));
    await runtime.scheduler.dispatch(true);
    const web = await openHttp(runtime, 0, [work]);
    let accepted!: () => void;
    const ready = new Promise<void>((resolve) => (accepted = resolve));
    let drop = true,
      changed = false,
      errorAfterAcceptance = false,swapAfterMeta=false;
    const proxy = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const response = await fetch(
        `http://127.0.0.1:${(web.server.address() as any).port}${req.url}`,
        {
          method: req.method,
          headers: {
            Authorization: req.headers.authorization!,
            ...(req.headers["x-relay-server-id"]?{"X-Relay-Server-ID":String(req.headers["x-relay-server-id"])}:{}),
            "Content-Type": "application/json",
          },
          body: body || undefined,
        },
      );
      let text = await response.text();
      if(req.url==="/api/meta"&&swapAfterMeta){swapAfterMeta=false;(runtime as any).installationId=randomUUID();}
      if (req.url === "/api/meta" && changed)
        text = JSON.stringify({ ...JSON.parse(text), serverId: randomUUID() });
      if (req.method === "POST" && drop) {
        drop = false;
        accepted();
        res.destroy();
        return;
      }
      if (req.method === "POST" && errorAfterAcceptance) {
        errorAfterAcceptance = false;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Lost persistence acknowledgement" }));
        return;
      }
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(text);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as any).port}`,
      env = { ...process.env, RELAY_REMOTE_HOME: path.join(root, "client") },
      run = (args: string[]) =>
        exec(process.execPath, ["scripts/remote.cjs", ...args], { env });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await run([
        "profile",
        "save",
        "server",
        "--url",
        url,
        "--token-file",
        path.join(runtime.store.root, "http-token"),
        "--cwd",
        work,
        "--host",
        "user@server.example",
      ]);
      const tunnel = await exec(
        process.execPath,
        ["scripts/remote-tunnel.cjs", "--profile", "server", "--check"],
        { env },
      );
      expect(JSON.parse(tunnel.stdout).args).toContain("user@server.example");
      const id = randomUUID();
      child = spawn(
        process.execPath,
        [
          "scripts/remote.cjs",
          "run",
          "--profile",
          "server",
          "--prompt",
          "One accepted task",
          "--request-id",
          id,
          "--detach",
        ],
        { env, stdio: "ignore" },
      );
      await ready;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      child = undefined;
      const store = new RemoteStore(env.RELAY_REMOTE_HOME);
      expect(store.read(id).state).toBe("pending");
      expect(runtime.store.data.jobs).toHaveLength(1);
      const recovered = await run([
        "recover",
        "--profile",
        "server",
        "--request-id",
        id,
      ]);
      expect(JSON.parse(recovered.stdout).id).toBe(
        runtime.store.data.jobs[0].id,
      );
      expect(runtime.store.data.jobs).toHaveLength(1);
      expect(store.read(id).state).toBe("confirmed");
      // Older clients marked even an ambiguous 4xx as rejected. Explicit
      // recovery upgrades that receipt without changing its identity.
      store.finish({ ...store.read(id), state: "pending" }, undefined, "old error");
      await run(["recover", "--profile", "server", "--request-id", id]);
      expect(store.read(id).state).toBe("confirmed");
      expect(runtime.store.data.jobs).toHaveLength(1);
      const secondId = randomUUID();
      errorAfterAcceptance = true;
      await expect(run(["run", "--profile", "server", "--prompt", "Accepted before error", "--request-id", secondId, "--detach"])).rejects.toThrow("Lost persistence acknowledgement");
      expect(store.read(secondId).state).toBe("pending");
      expect(runtime.store.data.jobs).toHaveLength(2);
      const second = await run(["recover", "--profile", "server", "--request-id", secondId]);
      expect(JSON.parse(second.stdout).id).toBe(runtime.store.data.jobs[1].id);
      expect(runtime.store.data.jobs).toHaveLength(2);
      const originalServerId=runtime.installationId,raceId=randomUUID();swapAfterMeta=true;
      await expect(run(["run","--profile","server","--prompt","Deployment race","--request-id",raceId,"--detach"])).rejects.toThrow("Server installation changed");
      expect(store.read(raceId).state).toBe("pending");expect(runtime.store.data.jobs).toHaveLength(2);
      (runtime as any).installationId=originalServerId;
      await run(["recover","--profile","server","--request-id",raceId]);expect(runtime.store.data.jobs).toHaveLength(3);
      changed = true;
      await expect(
        run(["recover", "--profile", "server", "--request-id", id]),
      ).rejects.toThrow("installation differs");
      expect(runtime.store.data.jobs).toHaveLength(3);
    } finally {
      child?.kill("SIGKILL");
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await web.close();
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
