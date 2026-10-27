import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ServerRuntime } from "../src/server/runtime";
import { ServerAssets } from "../src/server/assets";
it.skipIf(process.platform !== "linux")(
  "downloads only current recorded artifacts, redacts text and blocks escaping links/private state",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-assets-")),
      work = path.join(root, "work");
    await fs.mkdir(work);
    const runtime = await ServerRuntime.open(path.join(root, "data"));
    await runtime.scheduler.dispatch(true);
    try {
      const job: any = await runtime.command("job.add", {
        title: "Assets",
        prompt: "Make files",
        cwd: work,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      const text = path.join(work, "result.txt"),
        image = path.join(work, "result.png"),
        escape = path.join(work, "escape.txt"),
        unrecorded = path.join(work, "unrecorded.txt");
      const dottedToken = "rt.1." + "Synthetic_0123456789-".repeat(4);
      await fs.writeFile(text, "result api_key: private-credential\n" + dottedToken);
      await fs.writeFile(image, Buffer.from([137, 80, 78, 71, 0, 0]));
      await fs.writeFile(unrecorded, "not registered");
      await fs.symlink(path.join(runtime.store.root, "state.json"), escape);
      await runtime.scheduler.chats.append(job.id, {
        id: "outputs",
        role: "tool",
        kind: "fileChange",
        text: "Generated",
        at: Date.now(),
        data: {
          changes: [
            { path: text },
            { path: image },
            { path: escape },
            { path: path.join(runtime.store.root, "state.json") },
          ],
        },
      });
      const assets = new ServerAssets(runtime, [work]),
        list = await assets.list(job.id);
      expect(list.files.map((f) => f.name).sort()).toEqual([
        "result.png",
        "result.txt",
      ]);
      const result = await assets.read(
        job.id,
        list.files.find((f) => f.name === "result.txt")!.id,
      );
      expect(result.preview).toContain("[REDACTED]");
      expect(result.preview).not.toContain(dottedToken);
      expect(Buffer.from(result.data, "base64").toString()).not.toContain(dottedToken);
      expect(Buffer.from(result.data, "base64").toString()).not.toContain(
        "private-credential",
      );
      const binary = await assets.read(
        job.id,
        list.files.find((f) => f.name === "result.png")!.id,
      );
      expect(binary.mime).toBe("image/png");
      expect(binary.redacted).toBe(false);
      await fs.writeFile(text, "changed");
      await expect(
        assets.read(
          job.id,
          list.files.find((f) => f.name === "result.txt")!.id,
        ),
      ).rejects.toThrow("changed");
      const next = (await assets.list(job.id)).files.find(
        (f) => f.name === "result.txt",
      )!;
      await fs.rm(text);
      await fs.symlink(path.join(runtime.store.root, "state.json"), text);
      await expect(assets.read(job.id, next.id)).rejects.toThrow();
      await expect(assets.read(job.id, "../../state.json")).rejects.toThrow();
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform!=="linux")("delivers isolated schedule artifacts after plan removal without exposing other private data",async()=>{
 const {promisify}=await import("node:util"),{execFile}=await import("node:child_process"),{randomUUID}=await import("node:crypto"),exec=promisify(execFile);
 const base=await fs.mkdtemp(path.join(os.tmpdir(),"relay-worktree-assets-")),work=path.join(base,"project");await fs.mkdir(work);
 const git=(...args:string[])=>exec("git",["-C",work,...args]);await git("init","-b","main");await git("-c","user.name=QA","-c","user.email=qa@invalid.local","commit","--allow-empty","-m","fixture");
 const runtime=await ServerRuntime.open(path.join(base,"data"),undefined,[work]);await runtime.scheduler.dispatch(true);
 try{
 const id=randomUUID(),input={title:"Worktree",prompt:"Make output",cwd:work,enabled:false,cadence:"interval",minutes:60,hour:9,minute:0,weekday:1,worktree:true};
 await runtime.command("schedule.create",{requestId:randomUUID(),id,input});
 const receipt:any=await runtime.command("schedule.run",{requestId:randomUUID(),id});expect(receipt.state).toBe("succeeded");const job=runtime.store.data.jobs[0];
 expect(job.schedule?.sourceCwd).toBe(work);
 const result=path.join(job.cwd,"result.txt");await fs.writeFile(result,"isolated result");
 await runtime.scheduler.chats.append(job.id,{id:"generated",role:"tool",kind:"fileChange",text:"Output",at:Date.now(),data:{changes:[{path:result},{path:path.join(runtime.store.root,"state.json")}]}});
 await runtime.scheduler.chats.user(job.id,"Read output",result);
 const assets=new ServerAssets(runtime,[work]);const listed=await assets.list(job.id);expect(listed.files.map(f=>f.name)).toEqual(["result.txt"]);
 await runtime.command("schedule.remove",{requestId:randomUUID(),id});expect((await assets.read(job.id,listed.files[0].id)).preview).toBe("isolated result");
 expect((await new ServerAssets(runtime,[]).list(job.id)).files).toHaveLength(0);
 const original=job.cwd;await fs.rename(original,original+"-saved");await fs.writeFile(path.join(runtime.store.root,"result.txt"),"private state");await fs.symlink(runtime.store.root,original);
 expect((await assets.list(job.id)).files).toHaveLength(0);await expect(assets.read(job.id,listed.files[0].id)).rejects.toThrow();
 }finally{await runtime.close();await fs.rm(base,{recursive:true,force:true});}
});
