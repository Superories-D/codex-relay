import os from "node:os";
import {beforeAll} from "vitest";
import {beforeEach,afterEach,it,expect} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-handoff-qa");
beforeAll(async()=>{await fs.mkdir(fixtureParent,{recursive:true});});
import {randomUUID} from "node:crypto";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {prepareCheckpoint} from "../src/main/checkpoint-capture";
import {checkpointManifest} from "../src/shared/checkpoints";
import {adoptionSourceSignature,captureAdoptionRepositoryGuards,assertAdoptionRepositoryGuards,withAdoptionRepositoryLeases} from "../src/main/handoff-adoption-guards";
let fixture:string,root:string,git:CheckpointGit,controller:AbortController;
const parent=fixtureParent;
beforeEach(async()=>{controller=new AbortController();await fs.mkdir(parent,{recursive:true});fixture=await fs.mkdtemp(path.join(parent,"adoption-guards-"));await fs.writeFile(path.join(fixture,".owner"),fixture);root=path.join(fixture,"Project");await fs.mkdir(root);git=new CheckpointGit(path.join(fixture,"commands"),{native:false,signal:controller.signal});await git.run(root,["init","-b","main"]);await git.run(root,["config","user.name","QA"]);await git.run(root,["config","user.email","qa@localhost"]);await git.run(root,["config","core.autocrlf","false"]);await fs.writeFile(path.join(root,"raw.txt"),"base\r\n");await git.run(root,["add","-A"]);await git.run(root,["commit","-m","Base"]);},120000);
afterEach(async()=>{controller.abort();const actual=await fs.realpath(fixture);if(path.dirname(actual)!==await fs.realpath(parent)||!path.basename(actual).startsWith("adoption-guards-")||await fs.readFile(path.join(actual,".owner"),"utf8")!==fixture)throw Error("Unsafe adoption guard fixture cleanup");await fs.rm(actual,{recursive:true,force:true});},30000);
async function capture(cwd=root){const storage=path.join(fixture,randomUUID());await fs.mkdir(storage);return prepareCheckpoint(cwd,"Source",{root:storage,native:false,signal:controller.signal});}
it("compares a fresh capture with its schema-normalized archived representation",async()=>{
  const original=(await capture()).manifest,archived=checkpointManifest.parse(JSON.parse(JSON.stringify(original)));expect(adoptionSourceSignature(original)).toBe(adoptionSourceSignature(archived));
},120000);
async function guards(cwd=root){return captureAdoptionRepositoryGuards((await capture(cwd)).manifest,path.join(fixture,"guard-commands"),{native:false,signal:controller.signal});}
async function assertReleased(values:Awaited<ReturnType<typeof guards>>){for(const value of values){for(const file of value.lockPaths)await expect(fs.access(file)).rejects.toThrow();await expect(fs.access(path.join(value.branch?value.commonDir:value.gitDir,value.branch||"HEAD")+".lock")).rejects.toThrow();}}
it("holds actual Git index, configuration, HEAD and prepared branch verification leases without updating original metadata",async()=>{
  await git.run(root,["config","extensions.worktreeConfig","true"]);
  await fs.writeFile(path.join(root,"raw.txt"),"staged user\r\n");await git.run(root,["add","raw.txt"]);await fs.writeFile(path.join(root,"raw.txt"),"unstaged user\r\n");const values=await guards(),index=await fs.readFile(values[0].index),head=await git.text(root,["rev-parse","HEAD"]);let entered=false;
  const answer=await withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async signal=>{entered=true;signal.throwIfAborted();await expect(git.run(root,["add","raw.txt"])).rejects.toThrow();await expect(git.run(root,["config","--local","adoption.qa","must not write"])).rejects.toThrow();await expect(git.run(root,["update-ref","refs/heads/main",head,head])).rejects.toThrow();expect(await fs.readFile(values[0].index)).toEqual(index);expect(await fs.readFile(path.join(root,"raw.txt"),"utf8")).toBe("unstaged user\r\n");return"protected";});expect(answer).toBe("protected");expect(entered).toBe(true);await assertReleased(values);await assertAdoptionRepositoryGuards(values,path.join(fixture,"after-commands"),{native:false});expect(await fs.readFile(values[0].index)).toEqual(index);expect(await git.text(root,["rev-parse","HEAD"])).toBe(head);
},180000);
it("aborts prepared refs and releases only owned locks after an action fails or is cancelled",async()=>{
  const values=await guards();await expect(withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async()=>{throw Error("Injected action failure");})).rejects.toThrow("Injected action failure");await assertReleased(values);
  const cancellation=new AbortController();await expect(withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false,signal:cancellation.signal},async signal=>{cancellation.abort(Error("User paused adoption"));signal.throwIfAborted();})).rejects.toThrow("User paused adoption");await assertReleased(values);await assertAdoptionRepositoryGuards(values,path.join(fixture,"after-commands"),{native:false});
},180000);
it("blocks worktree-specific configuration and packed-reference rewrites during adoption",async()=>{
  await git.run(root,["config","extensions.worktreeConfig","true"]);await git.run(root,["config","--worktree","adoption.qa","original"]);const values=await guards();await withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async()=>{await expect(git.run(root,["config","--worktree","adoption.qa","changed"])).rejects.toThrow();await expect(git.run(root,["pack-refs","--all"])).rejects.toThrow();});await assertReleased(values);await assertAdoptionRepositoryGuards(values,path.join(fixture,"after-commands"),{native:false});expect(await git.text(root,["config","--worktree","adoption.qa"])).toBe("original");
},180000);
it("refuses stale original metadata before entry and preserves an existing foreign index lock",async()=>{
  const values=await guards(),file=values[0].index+".lock";await fs.writeFile(file,"foreign lock",{flag:"wx"});let entered=false;await expect(withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async()=>{entered=true;})).rejects.toThrow();expect(entered).toBe(false);expect(await fs.readFile(file,"utf8")).toBe("foreign lock");const stat=await fs.lstat(file);expect(stat.isFile()&&!stat.isSymbolicLink()).toBe(true);await fs.unlink(file);
  await git.run(root,["config","adoption.changed","yes"]);await expect(withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async()=>{entered=true;})).rejects.toThrow("发生变化");expect(entered).toBe(false);await assertReleased(values);
},180000);
it("verifies detached HEAD and an unborn SHA-256 branch without inventing a commit or leaving ref locks",async()=>{
  await git.run(root,["checkout","--detach"]);const detached=await guards();expect(detached[0].branch).toBe("");await withAdoptionRepositoryLeases(detached,path.join(fixture,"lease-commands"),{native:false},async()=>{expect(await git.text(root,["rev-parse","HEAD"])).toBe(detached[0].head);});await assertReleased(detached);
  const unborn=path.join(fixture,"Unborn");await fs.mkdir(unborn);await git.run(unborn,["init","--object-format=sha256","-b","main"]);await fs.writeFile(path.join(unborn,"raw.txt"),"unborn working\r\n");const fresh=await guards(unborn);expect(fresh[0].head).toBeUndefined();await withAdoptionRepositoryLeases(fresh,path.join(fixture,"lease-commands"),{native:false},async()=>{expect(await fs.readFile(path.join(unborn,"raw.txt"),"utf8")).toBe("unborn working\r\n");});await assertReleased(fresh);await expect(git.text(unborn,["rev-parse","--verify","HEAD"])).rejects.toThrow();
},180000);
it("recognizes independent copies of one source while distinguishing raw working bytes and original staging",async()=>{
  await fs.writeFile(path.join(root,"raw.txt"),"staged\r\n");await git.run(root,["add","raw.txt"]);await fs.writeFile(path.join(root,"raw.txt"),"raw working\r\n");const first=(await capture()).manifest,second=(await capture()).manifest;expect(first.id).not.toBe(second.id);expect(first.repos[0].id).not.toBe(second.repos[0].id);expect(adoptionSourceSignature(first)).toBe(adoptionSourceSignature(second));await fs.writeFile(path.join(root,"raw.txt"),"new raw working\r\n");const changed=(await capture()).manifest;expect(adoptionSourceSignature(changed)).not.toBe(adoptionSourceSignature(first));await fs.writeFile(path.join(root,"raw.txt"),"raw working\r\n");await git.run(root,["add","raw.txt"]);expect(adoptionSourceSignature((await capture()).manifest)).not.toBe(adoptionSourceSignature(first));
},240000);
it("protects the separate HEAD and shared branch of an actual linked worktree",async()=>{
  const linked=path.join(fixture,"Linked");await git.run(root,["worktree","add","-b","linked",linked]);await fs.writeFile(path.join(linked,"raw.txt"),"linked user content\r\n");const values=await guards(linked),head=await git.text(linked,["rev-parse","HEAD"]),originalHead=await fs.readFile(path.join(values[0].gitDir,"HEAD"));expect(values[0].gitDir).not.toBe(values[0].commonDir);
  await withAdoptionRepositoryLeases(values,path.join(fixture,"lease-commands"),{native:false},async()=>{await expect(fs.access(path.join(values[0].gitDir,"HEAD.lock"))).resolves.toBeUndefined();await expect(git.run(linked,["symbolic-ref","HEAD","refs/heads/main"])).rejects.toThrow();await expect(git.run(root,["update-ref","refs/heads/linked",head,head])).rejects.toThrow();expect(await fs.readFile(path.join(values[0].gitDir,"HEAD"))).toEqual(originalHead);});await assertReleased(values);expect(await fs.readFile(path.join(linked,"raw.txt"),"utf8")).toBe("linked user content\r\n");
},180000);
it("runs a prepared reference lease inside the actual Windows process domain",async()=>{
  const values=await guards();await withAdoptionRepositoryLeases(values,path.join(fixture,"native-lease-commands"),{native:true},async signal=>{signal.throwIfAborted();await expect(git.run(root,["symbolic-ref","HEAD","refs/heads/elsewhere"])).rejects.toThrow();});await assertReleased(values);await assertAdoptionRepositoryGuards(values,path.join(fixture,"after-commands"),{native:false});
},180000);
