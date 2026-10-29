import os from "node:os";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import {Checkpoints} from "../src/main/checkpoints";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {atomicWrite} from "../src/core/store";
let root:string,source:string,profile:string,service:Checkpoints,git:CheckpointGit;
beforeEach(async()=>{const parent=path.resolve(process.env.RELAY_QA_ROOT||path.join(os.tmpdir(),"codex-relay-qa"));await fs.mkdir(parent,{recursive:true});root=await fs.mkdtemp(path.join(parent,"checkpoint-service-"));source=path.join(root,"source");profile=path.join(root,"profile");await fs.mkdir(source);git=new CheckpointGit(path.join(root,"git"),{native:false});await git.run(source,["init","-b","main"]);await git.run(source,["config","user.name","QA"]);await git.run(source,["config","user.email","qa@localhost"]);await git.run(source,["config","core.autocrlf","false"]);await fs.writeFile(path.join(source,"a"),"base");await git.run(source,["add","a"]);await git.run(source,["commit","-m","Base"]);service=new Checkpoints({root:profile,native:false});});
afterEach(async()=>{await service?.shutdown();const physical=await fs.realpath(root),parent=await fs.realpath(path.resolve(process.env.RELAY_QA_ROOT||path.join(os.tmpdir(),"codex-relay-qa")));if(path.dirname(physical)!==parent||!path.basename(physical).startsWith("checkpoint-service-"))throw Error("Unsafe checkpoint service fixture cleanup");await fs.rm(physical,{recursive:true,force:true});});
async function idle(){const deadline=Date.now()+45000;for(;;){const view=await service.list();if(!view.active)return view;if(Date.now()>deadline)throw Error(`Checkpoint operation did not settle: ${JSON.stringify(view)}`);await new Promise(resolve=>setTimeout(resolve,20));}}
async function preview(){const view=await service.preview({cwd:source,title:"Review"}),id=view.entries.at(-1)!.id,done=await idle();expect(done.entries.at(-1)!.status).toBe("preview");return id;}
async function ready(){const id=await preview();await service.capture(id);const view=await idle();expect(view.entries.at(-1)!.status,view.entries.at(-1)!.issue).toBe("ready");return id;}
it("publishes a durable checkpoint, restores independent workspaces and reopens the same receipt after restart",async()=>{
  await fs.writeFile(path.join(source,"a"),"working");const id=await ready(),detail=await service.detail({id});expect(detail.total).toBe(1);const requestId=crypto.randomUUID();await service.restore({id,requestId,mode:"independent"});await service.restore({id,requestId,mode:"independent"});const first=(await idle()).restores[0];expect(first.status,first.issue).toBe("ready");expect(await fs.readFile(path.join(first.target,"a"),"utf8")).toBe("working");
  await service.shutdown();service=new Checkpoints({root:profile,native:false});expect((await service.list()).restores[0].target).toBe(first.target);await service.restore({id,requestId,mode:"independent"});await service.recover(first.id);expect((await idle()).restores).toHaveLength(1);expect((await service.list()).restores[0].status).toBe("ready");
},45000);
it("retains a fully sealed stage after publication failure and recovers it by complete verification",async()=>{
  const id=await preview(),stage=path.join(profile,"workspace-checkpoints/staging",id),target=path.join(profile,"workspace-checkpoints/versions",id);await fs.mkdir(target);await fs.writeFile(path.join(target,"user-owned"),"do not overwrite");await service.capture(id);const failed=(await idle()).entries[0];expect(failed.status).toBe("failed");expect(failed.manifestSha256).toBeDefined();expect(await fs.readFile(path.join(target,"user-owned"),"utf8")).toBe("do not overwrite");expect(await fs.readFile(path.join(stage,"manifest.json"),"utf8")).toContain(id);
  await fs.rm(path.join(target,"user-owned"));await fs.rmdir(target);await service.shutdown();service=new Checkpoints({root:profile,native:false});await service.verify(id);const recovered=(await idle()).entries[0];expect(recovered.status,recovered.issue).toBe("ready");
},45000);
it("refuses stale capture, cancels an active preview and requires a fresh preview after restart",async()=>{
  const id=await preview();await fs.writeFile(path.join(source,"a"),"changed");await service.capture(id);expect((await idle()).entries[0].status).toBe("failed");
  const view=await service.preview({cwd:source,title:"Cancel"});await service.cancel(view.active!.id);expect((await idle()).entries[1].status).toBe("cancelled");
  await preview();await service.shutdown();service=new Checkpoints({root:profile,native:false});expect((await service.list()).entries[2].status).toBe("interrupted");await expect(service.capture((await service.list()).entries[2].id)).rejects.toThrow("重新创建");
},30000);
it("never accepts tampered saved bytes or a modified restored file as verified evidence",async()=>{
  const id=await ready(),view=await service.list(),entry=view.entries[0],directory=path.join(entry.root,"versions",entry.id),manifest=JSON.parse(await fs.readFile(path.join(directory,"manifest.json"),"utf8"));
  await service.restore({id,requestId:crypto.randomUUID(),mode:"independent"});const restored=(await idle()).restores[0];expect(restored.status).toBe("ready");await fs.writeFile(path.join(restored.target,"a"),"later edit");await service.recover(restored.id);expect((await idle()).restores[0].status).toBe("failed");expect(await fs.readFile(path.join(restored.target,"a"),"utf8")).toBe("later edit");
  await fs.writeFile(path.join(directory,manifest.repos[0].files[0].stored.path),"tampered");await service.verify(id);expect((await idle()).entries[0].status).toBe("interrupted");
},45000);
it("fails closed on catalog write failure and leaves the previous catalog intact",async()=>{
  await service.list();await service.shutdown();const before=await fs.readFile(path.join(profile,"workspace-checkpoints.json")),write=vi.fn<typeof atomicWrite>().mockRejectedValue(Error("disk full"));service=new Checkpoints({root:profile,native:false,write});await expect(service.preview({cwd:source,title:"Storage failure"})).rejects.toThrow("记录无法保存");expect((await fs.readFile(path.join(profile,"workspace-checkpoints.json"))).equals(before)).toBe(true);expect((await service.list()).active).toBeUndefined();
});
it("opens an associated task after it starts without requesting a new checkpoint or admitting another task",async()=>{
  const id=await ready();await service.restore({id,requestId:crypto.randomUUID(),mode:"independent"});const restore=(await idle()).restores[0];await service.shutdown();
  const job:any={id:crypto.randomUUID(),state:"paused",cwd:restore.target},admit=vi.fn(async()=>job),target=vi.fn(()=>{throw Error("Task is running; cannot capture");}),lookup=vi.fn(()=>job);service=new Checkpoints({root:profile,native:false,admit,target,lookup});
  await service.admit({id:restore.id,title:"Inspect",prompt:"Review restored files"});job.state="running";expect((await service.task(restore.id)).state).toBe("running");expect((await service.admit({id:restore.id,title:"Retry",prompt:"Retry"})).id).toBe(job.id);expect(admit).toHaveBeenCalledTimes(1);expect(target).not.toHaveBeenCalled();
},30000);
it("cancels a background source review without invalidating the saved checkpoint, then restores from a fresh review",async()=>{
  const id=await ready(),review=await service.linkedReview(id);expect(review.active?.kind).toBe("review");await service.cancel(review.active!.id);let view=await idle();expect(view.entries[0].status).toBe("ready");expect(view.linkedReview).toBeUndefined();
  await service.linkedReview(id);view=await idle();expect(view.linkedReview?.entryId,view.entries[0].issue).toBe(id);await service.restore({id,requestId:crypto.randomUUID(),mode:"linked",review:view.linkedReview!.token});view=await idle();expect(view.restores[0].status,view.restores[0].issue).toBe("ready");
},90000);
