import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { RemoteActions } from "../src/server/actions";
import { atomicWrite } from "../src/core/store";
it("records intent before effects, deduplicates concurrency and refuses conflict/replay after crash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-actions-"));
  try {
    const actions = new RemoteActions(root),
      id = randomUUID(),
      job = randomUUID();
    let calls = 0;
    const effect = async () => {
      calls++;
      expect((await actions.read(id))?.state).toBe("pending");
      return { applied: true };
    };
    const results = await Promise.all([
      actions.run(id, "steer", job, { text: "one" }, effect),
      actions.run(id, "steer", job, { text: "one" }, effect),
    ]);
    expect(calls).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(
      (
        await new RemoteActions(root).run(
          id,
          "steer",
          job,
          { text: "one" },
          effect,
        )
      ).state,
    ).toBe("succeeded");
    await expect(
      actions.run(id, "steer", job, { text: "other" }, effect),
    ).rejects.toThrow("different");
    let writes = 0;
    const crash = new RemoteActions(root, async (file, text) => {
      if (++writes === 2) throw Error("disk lost");
      await atomicWrite(file, text);
    });
    const crashId = randomUUID();
    await expect(
      crash.run(crashId, "steer", job, {}, async () => {
        calls++;
      }),
    ).rejects.toThrow("disk lost");
    expect(
      (await new RemoteActions(root).run(crashId, "steer", job, {}, effect))
        .state,
    ).toBe("pending");
    expect(calls).toBe(2);
    const fail = new RemoteActions(root, async () => {
      throw Error("disk full");
    });
    await expect(
      fail.run(randomUUID(), "steer", job, {}, effect),
    ).rejects.toThrow("disk full");
    expect(calls).toBe(2);
    const uncertain = await actions.run(
      randomUUID(),
      "steer",
      job,
      {},
      async () => {
        throw Error("api_key: secret lost");
      },
    );
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.error).not.toContain("secret");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "linux")(
  "recovers model-blocked jobs once and reports stale model changes",
  async () => {
    const { ServerRuntime } = await import("../src/server/runtime");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-"));
    const runtime = await ServerRuntime.open(root);
    try {
      await runtime.scheduler.dispatch(true);
      const job: any = await runtime.command("job.add", {
        title: "model",
        prompt: "test",
        cwd: root,
        mode: "cli",
        model: "blocked",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      job.state = "waiting";
      job.waitingFor = "model";
      await runtime.store.save();
      const args = {
        requestId: randomUUID(),
        id: job.id,
        model: "available",
        effort: "high",
      };
      const first: any = await runtime.command("task.model", args);
      expect(first.result).toEqual({ applied: true });
      expect(job.state).toBe("queued");
      expect(job.model).toBe("available");
      expect(await runtime.command("task.model", args)).toEqual(first);
      const stale: any = await runtime.command("task.model", {
        ...args,
        requestId: randomUUID(),
        model: "other",
      });
      expect(stale.result).toEqual({ applied: false });
      expect(job.model).toBe("available");
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
it("pages operation history without exposing result payloads and keeps unreadable receipts visible",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-actions-list-"));
 try{
 const actions=new RemoteActions(root),job=randomUUID();expect((await actions.list()).entries).toEqual([]);
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 for(let i=0;i<ids.length;i++){
  await actions.run(ids[i],"test.action",job,{prompt:"private input"},async()=>({prompt:"private result"}));
  await fs.utimes(path.join(root,"remote-actions",ids[i]+".json"),100+i,100+i);
 }
 const first=await actions.list({limit:2});expect(first.entries.map(e=>e.id)).toEqual([ids[2],ids[1]]);expect(JSON.stringify(first)).not.toContain("private");expect(JSON.stringify(first)).not.toContain("fingerprint");
 const second=await actions.list({limit:2,before:first.next});expect(second.entries.map(e=>e.id)).toEqual([ids[0]]);expect(second.next).toBeUndefined();
 await fs.writeFile(path.join(root,"remote-actions",ids[0]+".json"),"broken");
 const corrupt=await actions.list({limit:1});expect(corrupt.entries[0]).toMatchObject({id:ids[0],state:"unavailable"});
 await expect(actions.list({limit:51})).rejects.toThrow();await expect(actions.list({before:{at:0,id:"../escape"}})).rejects.toThrow();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
it("returns the same immutable effect result that was durably recorded",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-action-snapshot-"));
  try {
    const live={revision:1,title:"Committed state"};let writes=0;
    const actions=new RemoteActions(root,async(file,value)=>{await atomicWrite(file,value);if(++writes===2){live.revision=2;live.title="Later edit";}});
    const receipt=await actions.run(randomUUID(),"schedule.save",randomUUID(),{},async()=>live);
    expect(receipt.result).toEqual({revision:1,title:"Committed state"});
    expect(await actions.read(receipt.id)).toEqual(receipt);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
