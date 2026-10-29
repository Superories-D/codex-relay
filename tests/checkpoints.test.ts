import {beforeEach,afterEach,it,expect} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-checkpoint-qa");
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {prepareCheckpoint,captureCheckpointFiles,assertCheckpointSource} from "../src/main/checkpoint-capture";
import {verifyCheckpointFile} from "../src/main/checkpoint-file";
import {restoreCheckpoint,verifyRestoredCheckpoint} from "../src/main/checkpoint-restore";
import {reviewLinkedCheckpoint} from "../src/main/checkpoint-linked";
let root:string,source:string,storage:string,git:CheckpointGit;
const digest=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
async function write(name:string,body:string|Buffer){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),body);}
beforeEach(async()=>{const parent=fixtureParent;await fs.mkdir(parent,{recursive:true});root=await fs.mkdtemp(path.join(parent,"checkpoint-test-"));source=path.join(root,"source");storage=path.join(root,"stage");await fs.mkdir(source);await fs.mkdir(storage);git=new CheckpointGit(path.join(root,"git"),{native:false});
  await git.run(source,["init","-b","main"]);await git.run(source,["config","user.name","Relay QA"]);await git.run(source,["config","user.email","qa@invalid.local"]);await git.run(source,["config","core.autocrlf","false"]);
});
afterEach(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("checkpoint-test-"))throw Error("Unsafe checkpoint fixture cleanup");await fs.rm(actual,{recursive:true,force:true});});
const options=()=>({root:storage,native:false});
async function commit(){await git.run(source,["add","-A"]);await git.run(source,["commit","-m","Fixture"]);}
it("captures raw working bytes and the separate index without modifying source state, and packs every staged object",async()=>{
  await write(".gitignore",".env\n");await write("a.txt","base\n");await write("gone.txt","base\n");await commit();
  await write("a.txt","staged\n");await git.run(source,["add","--","a.txt"]);await write("a.txt","working\r\nraw\n");await fs.rm(path.join(source,"gone.txt"));await write("[日本語].bin",Buffer.from([0,1,254,255]));await write(".env","local only");
  const index=path.join(source,".git/index"),before=await fs.readFile(index),head=await git.text(source,["rev-parse","HEAD"]);
  const prepared=await prepareCheckpoint(source,"Checkpoint",options());expect(prepared.manifest.repos[0].files.map(f=>f.path)).not.toContain(".env");
  const manifest=await captureCheckpointFiles(prepared,options()),node=manifest.repos[0];expect(node.files.find(f=>f.path==="gone.txt")?.kind).toBe("absent");
  const file=node.files.find(f=>f.path==="a.txt")!;expect(file.stored?.sha256).toBe(digest(Buffer.from("working\r\nraw\n")));
  await verifyCheckpointFile(storage,node.pack!);expect((await fs.readFile(index)).equals(before)).toBe(true);expect(await git.text(source,["rev-parse","HEAD"])).toBe(head);
  const imported=path.join(root,"imported");await fs.mkdir(imported);await git.run(imported,["init"]);await git.run(imported,["index-pack","--stdin","--keep=checkpoint-test"],{stdinFile:path.join(storage,node.pack!.path)});
  for(const oid of node.roots)await git.run(imported,["cat-file","-e",oid]);
},45000);
it("requires a fresh preview when content, file selection or the source index changes",async()=>{
  await write("a","base");await commit();const prepared=await prepareCheckpoint(source,"Preview",options());await write("new","later");await expect(assertCheckpointSource(prepared,options())).rejects.toThrow("范围已变化");
},30000);
it("preserves conflict stages as objects without requiring a writable merged tree",async()=>{
  await write("conflict","base\n");await commit();await git.run(source,["checkout","-b","other"]);await write("conflict","other\n");await commit();await git.run(source,["checkout","main"]);await write("conflict","main\n");await commit();await expect(git.run(source,["merge","other"])).rejects.toThrow();
  const prepared=await prepareCheckpoint(source,"Conflict",options());expect(prepared.manifest.repos[0].stages.map(e=>e.stage)).toEqual([1,2,3]);const manifest=await captureCheckpointFiles(prepared,options());
  const attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await git.records(restored.target,["ls-files","--unmerged","-z"])).toHaveLength(3);
},45000);
it("preserves a split index and its shared base without changing the source index",async()=>{
  await write("a","base");await commit();await git.run(source,["update-index","--split-index"]);const before=await fs.readFile(path.join(source,".git/index"));
  const prepared=await prepareCheckpoint(source,"Split index",options());expect(prepared.manifest.repos[0].sharedIndex).toBeDefined();const manifest=await captureCheckpointFiles(prepared,options());expect((await fs.readFile(path.join(source,".git/index"))).equals(before)).toBe(true);
  const attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await git.text(restored.target,["rev-parse","--shared-index-path"])).toContain("sharedindex.");
},45000);
it("records explicitly selected ignored setup files and keeps other ignored files out",async()=>{
  await write(".gitignore","*.local\n");await commit();await write("chosen.local","chosen");await write("other.local","other");const prepared=await prepareCheckpoint(source,"Ignored",{...options(),ignored:["chosen.local"]});
  expect(prepared.manifest.repos[0].files.find(f=>f.path==="chosen.local")?.ignored).toBe(true);expect(prepared.manifest.repos[0].files.some(f=>f.path==="other.local")).toBe(false);
},30000);
it("records directory links without reading their external contents",async()=>{
  await write("a","base");await commit();const outside=path.join(root,"outside");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"private"),"outside bytes");await fs.symlink(outside,path.join(source,"linked"),"junction");
  const prepared=await prepareCheckpoint(source,"Link",options());const link=prepared.manifest.repos[0].files.find(f=>f.kind==="link");expect(link?.link?.external).toBe(true);expect(prepared.manifest.repos[0].files.some(f=>f.path.includes("private"))).toBe(false);
},30000);
it("restores complete working/index state after the source repository is removed",async()=>{
  await write(".gitattributes","*.txt text eol=crlf\n");await write("a.txt","base\r\n");await write("gone.txt","base\r\n");await commit();await write("a.txt","stage\n");await git.run(source,["add","--","a.txt"]);await write("a.txt","working mixed\r\nLF\n");await fs.rm(path.join(source,"gone.txt"));await write("[日本語].bin",Buffer.from([0,254,255]));
  const before=await git.run(source,["status","--porcelain=v1","-z"]),prepared=await prepareCheckpoint(source,"Independent",options()),manifest=await captureCheckpointFiles(prepared,options());
  const actual=await fs.realpath(source);if(path.dirname(actual)!==await fs.realpath(root)||path.basename(actual)!=="source")throw Error("Unsafe source fixture removal");await fs.rm(actual,{recursive:true,force:true});
  const attempt=path.join(root,"restore");await fs.mkdir(attempt);const result=await restoreCheckpoint(manifest,storage,attempt,{native:false});
  expect((await git.run(result.target,["status","--porcelain=v1","-z"])).equals(before)).toBe(true);expect(await fs.readFile(path.join(result.target,"a.txt"),"utf8")).toBe("working mixed\r\nLF\n");expect((await verifyRestoredCheckpoint(manifest,attempt,{native:false})).passed).toBe(true);
},60000);
it("restores intent-to-add and assume-unchanged as separate index semantics",async()=>{
  await write("a","base");await commit();await git.run(source,["update-index","--assume-unchanged","--","a"]);await write("new","not staged");await git.run(source,["add","-N","--","new"]);
  const prepared=await prepareCheckpoint(source,"Flags",options());expect(prepared.manifest.repos[0].flags.some(f=>f.bits==="20000000")).toBe(true);expect(prepared.manifest.repos[0].flags.some(f=>f.bits==="8000")).toBe(true);
  const manifest=await captureCheckpointFiles(prepared,options()),attempt=path.join(root,"restore");await fs.mkdir(attempt);const result=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await git.indexFlags(result.target)).toEqual(manifest.repos[0].flags);
},60000);
it("restores sparse checkout without expanding missing files",async()=>{
  await write("keep/a","kept");await write("hidden/b","hidden");await commit();await git.run(source,["sparse-checkout","init","--cone","--sparse-index"]);await git.run(source,["sparse-checkout","set","keep"]);
  const prepared=await prepareCheckpoint(source,"Sparse",options()),manifest=await captureCheckpointFiles(prepared,options()),attempt=path.join(root,"restore");await fs.mkdir(attempt);const result=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await fs.readFile(path.join(result.target,"keep/a"),"utf8")).toBe("kept");await expect(fs.access(path.join(result.target,"hidden/b"))).rejects.toThrow();
},60000);
it("creates a linked task branch while preserving the source HEAD, index, config and working bytes",async()=>{
  await write("a","base");await commit();await write("a","staged");await git.run(source,["add","a"]);await write("a","working");
  const prepared=await prepareCheckpoint(source,"Linked",options()),manifest=await captureCheckpointFiles(prepared,options()),review=await reviewLinkedCheckpoint(manifest,path.join(root,"review"),{native:false});
  const before={index:await fs.readFile(path.join(source,".git/index")),config:await fs.readFile(path.join(source,".git/config")),head:await git.text(source,["rev-parse","HEAD"])};
  const attempt=path.join(root,"restore");await fs.mkdir(attempt);const result=await restoreCheckpoint(manifest,storage,attempt,{native:false,linked:review,branch:"task/checkpoint"});
  expect(await git.text(result.target,["symbolic-ref","--short","HEAD"])).toBe("task/checkpoint");expect(await git.text(result.target,["rev-parse","--path-format=absolute","--git-common-dir"])).toBe((await fs.realpath(path.join(source,".git"))).split(path.sep).join("/"));
  expect((await fs.readFile(path.join(source,".git/index"))).equals(before.index)).toBe(true);expect((await fs.readFile(path.join(source,".git/config"))).equals(before.config)).toBe(true);expect(await git.text(source,["rev-parse","HEAD"])).toBe(before.head);expect(await fs.readFile(path.join(source,"a"),"utf8")).toBe("working");
},60000);
it("rejects a stale linked restore review before creating a worktree or branch",async()=>{
  await write("a","base");await commit();const prepared=await prepareCheckpoint(source,"Stale linked",options()),manifest=await captureCheckpointFiles(prepared,options()),review=await reviewLinkedCheckpoint(manifest,path.join(root,"review"),{native:false});
  await write("a","working edit after review");const attempt=path.join(root,"restore");await fs.mkdir(attempt);await expect(restoreCheckpoint(manifest,storage,attempt,{native:false,linked:review,branch:"task/stale"})).rejects.toThrow("预览后发生变化");expect(await git.text(source,["branch","--list","task/stale"])).toBe("");
},60000);
it("restores an unborn branch and every intended raw file without inventing a source commit",async()=>{
  await write("new","unborn bytes");await git.run(source,["add","new"]);await write("untracked","raw");const prepared=await prepareCheckpoint(source,"Unborn",options()),manifest=await captureCheckpointFiles(prepared,options()),attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});await expect(git.run(restored.target,["rev-parse","--verify","HEAD"])).rejects.toThrow();expect(await fs.readFile(path.join(restored.target,"new"),"utf8")).toBe("unborn bytes");
},60000);
it("restores an initialized submodule and an untracked nested repository with their own dirty indices",async()=>{
  await write("a","base");await commit();const nested=path.join(source,"nested");await fs.mkdir(nested);await git.run(nested,["init","-b","main"]);await git.run(nested,["config","user.name","QA"]);await git.run(nested,["config","user.email","qa@localhost"]);await fs.writeFile(path.join(nested,"inner"),"base");await git.run(nested,["add","inner"]);await git.run(nested,["commit","-m","Nested"]);
  await git.run(source,["-c","protocol.file.allow=always","submodule","add",nested,"module"]);await git.run(source,["add",".gitmodules","module"]);await git.run(source,["commit","-m","Module"]);await fs.writeFile(path.join(nested,"inner"),"nested dirty");await fs.writeFile(path.join(source,"module/inner"),"module dirty");
  const prepared=await prepareCheckpoint(source,"Nested",options()),manifest=await captureCheckpointFiles(prepared,options());expect(manifest.repos.map(r=>r.relative).sort()).toEqual(["","module","nested"]);const attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await fs.readFile(path.join(restored.target,"nested/inner"),"utf8")).toBe("nested dirty");expect(await fs.readFile(path.join(restored.target,"module/inner"),"utf8")).toBe("module dirty");
},45000);
it("keeps SHA-256 Git object identities when independently restoring a repository",async()=>{
  const other=path.join(root,"sha256");await git.run(root,["init","--object-format=sha256",other]);await git.run(other,["config","user.name","QA"]);await git.run(other,["config","user.email","qa@localhost"]);await fs.writeFile(path.join(other,"a"),"sha256 base");await git.run(other,["add","a"]);await git.run(other,["commit","-m","SHA256"]);const prepared=await prepareCheckpoint(other,"SHA256",options()),manifest=await captureCheckpointFiles(prepared,options());expect(manifest.repos[0].head).toHaveLength(64);const attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await git.text(restored.target,["rev-parse","--show-object-format"])).toBe("sha256");
},60000);
it("never executes repository clean/smudge filters while capturing and restoring raw bytes",async()=>{
  await write("a","base");await commit();const marker=path.join(root,"filter-ran"),filter=path.join(root,"filter.cjs");await fs.writeFile(filter,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);`);await git.run(source,["config","filter.checkpoint.clean",`node "${filter.split(path.sep).join("/")}"`]);await git.run(source,["config","filter.checkpoint.smudge",`node "${filter.split(path.sep).join("/")}"`]);await write(".gitattributes","a filter=checkpoint\n");await write("a","raw\r\nbytes\n");
  const prepared=await prepareCheckpoint(source,"Filters",options()),manifest=await captureCheckpointFiles(prepared,options());expect(manifest.repos[0].dependencies.some(d=>d.kind==="externalFilter")).toBe(true);const attempt=path.join(root,"restore");await fs.mkdir(attempt);const restored=await restoreCheckpoint(manifest,storage,attempt,{native:false});expect(await fs.readFile(path.join(restored.target,"a"),"utf8")).toBe("raw\r\nbytes\n");await expect(fs.access(marker)).rejects.toThrow();
  await fs.writeFile(path.join(restored.target,"later-untracked"),"later");await expect(verifyRestoredCheckpoint(manifest,attempt,{native:false})).rejects.toThrow("未记录的文件");await fs.rm(path.join(restored.target,"later-untracked"));
  const unsafe=path.join(root,"unsafe-attempt");await fs.mkdir(unsafe);await expect(restoreCheckpoint({...manifest,projectRelative:"../../escaped"},storage,unsafe,{native:false})).rejects.toThrow();expect(await fs.readdir(unsafe)).toEqual([]);
  await git.run(restored.target,["checkout","-b","user-changed-branch"]);await expect(verifyRestoredCheckpoint(manifest,attempt,{native:false})).rejects.toThrow("分支已变化");
},60000);
