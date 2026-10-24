import {promises as fs,createReadStream} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import {CheckpointGit,CheckpointGitError} from "./checkpoint-git";
import {parseCheckpointIndex} from "./checkpoint-capture";
import {checkpointManifest,checkpointPath,type CheckpointManifest,type CheckpointRepo,type CheckpointStoredFile} from "../shared/checkpoints";
import {checkpointFingerprint,checkpointOutputPath,insideCheckpoint,sameCheckpointPath,verifyCheckpointFile} from "./checkpoint-file";
import {copyVerifiedArtifact} from "./vault-file";
import {atomicWrite} from "../core/store";
import {assertLinkedCheckpoint,type LinkedCheckpointReview} from "./checkpoint-linked";
import {z} from "zod";

const layoutSchema=z.object({version:z.literal(1),checkpointId:z.string().uuid(),owner:z.string().uuid(),repos:z.array(z.object({id:z.string().uuid(),target:z.string(),gitDir:z.string(),commonDir:z.string(),branch:z.string(),targetIdentity:z.string(),gitIdentity:z.string(),commonIdentity:z.string()}).strict())}).strict();
async function directoryIdentity(directory:string){const stat=await fs.lstat(directory,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(directory,await fs.realpath(directory)))throw Error("恢复目录身份已变化");return[stat.dev,stat.ino].map(String).join(":");}
async function verifyRestoredInventory(manifest:CheckpointManifest,worktree:string,signal?:AbortSignal){
  const fold=(name:string)=>process.platform==="win32"?name.toLowerCase():name,expected=new Set(manifest.repos.flatMap(repo=>repo.files.filter(file=>file.kind!=="absent").map(file=>fold(repo.relative?`${repo.relative}/${file.path}`:file.path)))),repoRoots=new Set(manifest.repos.map(repo=>fold(repo.relative)));
  async function walk(folder:string,relative:string){signal?.throwIfAborted();await directoryIdentity(folder);for await(const item of await fs.opendir(folder)){
    signal?.throwIfAborted();if(item.name.toLowerCase()===".git"&&repoRoots.has(fold(relative)))continue;
    const name=relative?`${relative}/${item.name}`:item.name,file=path.join(folder,item.name),stat=await fs.lstat(file);
    if(stat.isDirectory()&&!stat.isSymbolicLink())await walk(file,name);else if(!expected.has(fold(name)))throw Error("恢复工作区出现未记录的文件，请重新检查");
  }}
  await walk(worktree,"");
}

export interface CheckpointRestoreOptions {signal?:AbortSignal;native?:boolean;branch?:string;exactIndex?:boolean;linked?:LinkedCheckpointReview;progress?:(phase:string,file:string,bytes:number)=>void}
function storedFiles(repo:CheckpointRepo){return [repo.index,repo.sharedIndex,repo.shallow,repo.sparse,repo.exclude,repo.globalExclude,repo.pack,...repo.files.map(f=>f.stored)].filter((v):v is CheckpointStoredFile=>!!v);}
const isolatedEnv:NodeJS.ProcessEnv={GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null"};
async function importObjects(git:CheckpointGit,repo:string,node:CheckpointRepo,root:string,linked=false){
  if(!node.pack)throw Error("检查点缺少独立 Git 对象归档");
  if(node.shallow&&!linked){const file=path.join(repo,".git/shallow");await fs.copyFile(path.join(root,node.shallow.path),file);}
  await git.run(repo,["index-pack","--stdin","--strict","--keep=codex-relay-checkpoint"],{stdinFile:path.join(root,node.pack.path),env:isolatedEnv});
  const out=path.join(git.scratch,`objects-${randomUUID()}.check`);
  await git.run(repo,["cat-file","--batch-check=%(objectname) %(objecttype) %(objectsize)"],{input:node.roots.join("\n")+(node.roots.length?"\n":""),output:out,env:isolatedEnv});
  let count=0;for await(const line of createInterface({input:createReadStream(out),crlfDelay:Infinity})){const [oid,type,size]=line.split(" ");if(oid!==node.roots[count++]||!["blob","tree","commit","tag"].includes(type)||!/^\d+$/.test(size))throw Error("检查点缺少恢复所需的完整 Git 对象");}
  if(count!==node.roots.length)throw Error("检查点 Git 对象核查未完成");await fs.rm(out);
}
export async function verifyCheckpointContents(input:CheckpointManifest,root:string,scratch:string,options:CheckpointRestoreOptions={}){
  const manifest=checkpointManifest.parse(input),git=new CheckpointGit(path.join(scratch,"commands"),options);await fs.mkdir(scratch,{recursive:true,mode:0o700});
  for(const node of manifest.repos){for(const file of storedFiles(node)){options.signal?.throwIfAborted();options.progress?.("verifying",file.path,0);await verifyCheckpointFile(root,file,options.signal);}
    const repo=path.join(scratch,node.id);await git.run(scratch,["init",`--object-format=${node.format}`,repo],{env:isolatedEnv});await importObjects(git,repo,node,root);
  }
  return manifest;
}
function validateRestorePaths(manifest:CheckpointManifest){
  const paths=new Map<string,string>(),fold=(p:string)=>process.platform==="win32"?p.toLowerCase():p;
  for(const node of manifest.repos){if(node.relative)checkpointPath.parse(node.relative);
    for(const file of node.files){const name=node.relative?`${node.relative}/${file.path}`:file.path,key=fold(name);checkpointPath.parse(name);
      if(paths.has(key))throw Error("检查点恢复路径冲突");paths.set(key,file.kind);
    }
  }
  for(const [name]of paths){let parent=name;while(parent.includes("/")){parent=parent.slice(0,parent.lastIndexOf("/"));const kind=paths.get(parent);if(kind&&kind!=="directory"&&kind!=="absent")throw Error("检查点恢复路径穿过链接或文件");}}
  if(manifest.repos[0].relative!==""||new Set(manifest.repos.map(n=>n.relative.toLowerCase())).size!==manifest.repos.length)throw Error("检查点仓库结构无法验证");
}
async function copyStored(root:string,file:CheckpointStoredFile,targetRoot:string,relative:string,signal?:AbortSignal){
  await copyVerifiedArtifact({cwd:root,relative:file.path,stagingRoot:targetRoot,output:relative,bytes:file.bytes,sha256:file.sha256,signal});
}
export async function restoreCheckpoint(input:CheckpointManifest,root:string,attempt:string,options:CheckpointRestoreOptions={}){
  const manifest=checkpointManifest.parse(input);validateRestorePaths(manifest);const canonical=await fs.realpath(attempt);if(!sameCheckpointPath(attempt,canonical)||(await fs.lstat(attempt)).isSymbolicLink()||(await fs.readdir(attempt)).length)throw Error("恢复目标必须是全新独立目录");
  const owner={version:1,id:randomUUID(),checkpointId:manifest.id,createdAt:Date.now()};await atomicWrite(path.join(attempt,".relay-checkpoint-restore.json"),JSON.stringify(owner));
  const rootBranch=options.branch||`checkpoint/${manifest.id}/${owner.id}`;
  const git=new CheckpointGit(path.join(attempt,"commands"),options),worktree=path.join(attempt,"workspace");
  const nodes=manifest.repos.slice().sort((a,b)=>a.relative.length-b.relative.length),targets=new Map<string,{repo:string;target:string;gitDir:string}>(),layout:z.infer<typeof layoutSchema>={version:1,checkpointId:manifest.id,owner:owner.id,repos:[]};
  // Full readback precedes creation of a usable target; no source repository is
  // needed and no checkout filters, hooks, remote fetches or setup scripts run.
  await verifyCheckpointContents(manifest,root,path.join(attempt,"audit"),options);
  if(options.linked)await assertLinkedCheckpoint(manifest,options.linked,path.join(attempt,"commands"),options);
  for(const node of nodes){
    options.signal?.throwIfAborted();options.progress?.("restoring",node.relative,0);
    const linked=options.linked?.repos.find(r=>r.id===node.id),repo=linked?.source||path.join(attempt,"repositories",node.id);
    if(!linked){await fs.mkdir(path.dirname(repo),{recursive:true});await git.run(attempt,["init",`--object-format=${node.format}`,repo],{env:isolatedEnv});}
    const branch=node.relative?`${rootBranch}/${node.id}`:rootBranch;await git.run(repo,["check-ref-format","--branch",branch],{env:isolatedEnv});
    const exists=await git.text(repo,["show-ref","--verify","--quiet",`refs/heads/${branch}`],isolatedEnv).then(()=>true,error=>{if(error.code===1)return false;throw error;});if(exists)throw Error("恢复分支已存在，请选择新的分支名");
    await importObjects(git,repo,node,root,!!linked);
    let base=node.head;
    if(!base){const tree=(await git.run(repo,["mktree"],{input:"",env:isolatedEnv})).toString().trim();base=(await git.run(repo,["commit-tree",tree],{input:"Codex Relay checkpoint base\n",env:{...isolatedEnv,GIT_AUTHOR_NAME:"Codex Relay",GIT_AUTHOR_EMAIL:"checkpoint@localhost",GIT_COMMITTER_NAME:"Codex Relay",GIT_COMMITTER_EMAIL:"checkpoint@localhost"}})).toString().trim();}
    await git.run(repo,["update-ref",`refs/codex-relay/checkpoints/${manifest.id}`,base],{env:isolatedEnv});if(!linked)await git.run(repo,["config","extensions.worktreeConfig","true"],{env:isolatedEnv});
    const target=node.relative?path.join(worktree,...node.relative.split("/")):worktree;
    if(node.relative){const parent=await checkpointOutputPath(worktree,`${node.relative}/.placeholder`);await fs.mkdir(path.dirname(parent),{recursive:true});}
    await git.run(repo,["worktree","add","--detach","--no-checkout",target,base],{env:isolatedEnv});
    if(node.head)await git.run(target,["update-ref",`refs/heads/${branch}`,node.head,"0".repeat(node.head.length)],{env:isolatedEnv});await git.run(target,["symbolic-ref","HEAD",`refs/heads/${branch}`],{env:isolatedEnv});
    const gitDir=await fs.realpath(await git.text(target,["rev-parse","--absolute-git-dir"],isolatedEnv));if(!insideCheckpoint(linked?path.join(linked.commonDir,"worktrees"):attempt,gitDir))throw Error("恢复仓库的管理目录已变化");
    if(!linked?.sharedConfig){
    for(const [key,value]of Object.entries(node.config)){if(!["core.filemode","core.ignorecase","core.symlinks","core.autocrlf","core.eol","core.sparsecheckout","core.sparsecheckoutcone","index.sparse"].includes(key))continue;await git.run(target,["config","--worktree",key,value],{env:isolatedEnv});}
    if(node.globalExclude){const file=path.join(gitDir,"global-exclude");await copyStored(root,node.globalExclude,gitDir,"global-exclude",options.signal);await git.run(target,["config","--worktree","core.excludesfile",file],{env:isolatedEnv});}
    else {const file=path.join(gitDir,"empty-exclude");await fs.writeFile(file,"");await git.run(target,["config","--worktree","core.excludesfile",file],{env:isolatedEnv});}
    if(node.exclude)await copyStored(root,node.exclude,gitDir,"info/exclude",options.signal);
    }
    if(node.sparse)await copyStored(root,node.sparse,gitDir,"info/sparse-checkout",options.signal);
    if(node.sharedIndex)await copyStored(root,node.sharedIndex,gitDir,node.sharedName!,options.signal);
    if(node.index)await copyStored(root,node.index,gitDir,"index",options.signal);
    targets.set(node.id,{repo,target,gitDir});
    const commonDir=await fs.realpath(await git.text(target,["rev-parse","--path-format=absolute","--git-common-dir"],isolatedEnv));layout.repos.push({id:node.id,target,gitDir,commonDir,branch,targetIdentity:await directoryIdentity(target),gitIdentity:await directoryIdentity(gitDir),commonIdentity:await directoryIdentity(commonDir)});
  }
  await atomicWrite(path.join(attempt,"restore-layout.json"),JSON.stringify(layout));
  // Files and directories precede links. No data copy traverses a restored link.
  for(const node of nodes){const {target}=targets.get(node.id)!;
    for(const file of node.files){options.signal?.throwIfAborted();if(file.kind==="absent"||file.kind==="link")continue;
      options.progress?.("restoring",file.path,0);
      if(file.kind==="directory"){const item=await checkpointOutputPath(target,`${file.path}/.placeholder`);await fs.mkdir(path.dirname(item),{recursive:true});continue;}
      await copyStored(root,file.stored!,target,file.path,options.signal);if(file.mode!==undefined)await fs.chmod(path.join(target,...file.path.split("/")),file.mode);
    }
  }
  for(const node of nodes){const {target}=targets.get(node.id)!;for(const file of node.files)if(file.kind==="link"){
    options.signal?.throwIfAborted();const out=await checkpointOutputPath(target,file.path),link=file.link!,destination=link.internal!==undefined?path.resolve(worktree,...link.internal.split("/")):link.target;
    await fs.symlink(destination,out,link.directory&&process.platform==="win32"?"junction":link.directory?"dir":"file");
  }}
  await verifyRestoredCheckpoint(manifest,attempt,{...options,exactIndex:true});options.signal?.throwIfAborted();
  if(options.linked)await assertLinkedCheckpoint(manifest,options.linked,path.join(attempt,"commands"),options);
  const result={...owner,target:manifest.projectRelative?path.join(worktree,...manifest.projectRelative.split("/")):worktree,root:worktree,branch:rootBranch,completedAt:Date.now()};
  await atomicWrite(path.join(attempt,"restore-receipt.json"),JSON.stringify(result));return result;
}
export async function verifyRestoredCheckpoint(manifest:CheckpointManifest,attempt:string,options:CheckpointRestoreOptions={}){
  validateRestorePaths(checkpointManifest.parse(manifest));await directoryIdentity(attempt);const worktree=path.join(await fs.realpath(attempt),"workspace"),git=new CheckpointGit(path.join(attempt,"commands"),options);
  const owner=JSON.parse(await fs.readFile(path.join(attempt,".relay-checkpoint-restore.json"),"utf8")),layout=layoutSchema.parse(JSON.parse(await fs.readFile(path.join(attempt,"restore-layout.json"),"utf8")));
  if(layout.checkpointId!==manifest.id||layout.owner!==owner.id||owner.checkpointId!==manifest.id||layout.repos.length!==manifest.repos.length)throw Error("恢复布局与检查点身份不一致");await directoryIdentity(worktree);
  await verifyRestoredInventory(manifest,worktree,options.signal);
  for(const node of manifest.repos){const target=node.relative?path.join(worktree,...node.relative.split("/")):worktree;
    const expected=layout.repos.find(repo=>repo.id===node.id);if(!expected||!sameCheckpointPath(expected.target,target)||expected.targetIdentity!==await directoryIdentity(target)||expected.gitIdentity!==await directoryIdentity(expected.gitDir)||expected.commonIdentity!==await directoryIdentity(expected.commonDir))throw Error("恢复工作区的归属已变化");
    const actualGit=await fs.realpath(await git.text(target,["rev-parse","--absolute-git-dir"],isolatedEnv)),actualCommon=await fs.realpath(await git.text(target,["rev-parse","--path-format=absolute","--git-common-dir"],isolatedEnv));if(!sameCheckpointPath(actualGit,expected.gitDir)||!sameCheckpointPath(actualCommon,expected.commonDir))throw Error("恢复工作区的 Git 指向已变化");
    for(const file of node.files){options.signal?.throwIfAborted();const out=path.join(target,...file.path.split("/"));
      if(file.kind==="absent"){try{await fs.lstat(out);throw Error("恢复的删除状态不一致");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}continue;}
      const stat=await fs.lstat(out);if(file.kind==="directory"){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("恢复目录无法验证");continue;}
      if(file.kind==="link"){if(!stat.isSymbolicLink())throw Error("恢复链接无法验证");const actual=await fs.readlink(out),expected=file.link!.internal!==undefined?path.resolve(worktree,...file.link!.internal.split("/")):path.resolve(path.dirname(out),file.link!.target);if(!sameCheckpointPath(path.resolve(path.dirname(out),actual),expected))throw Error("恢复链接目标不一致");continue;}
      const actual=await checkpointFingerprint(out,{signal:options.signal});if(actual.sha256!==file.stored!.sha256||actual.bytes!==file.stored!.bytes)throw Error("恢复文件字节与检查点不一致");
    }
    const index=await git.text(target,["rev-parse","--path-format=absolute","--git-path","index"],isolatedEnv);
    if(node.index&&options.exactIndex&&(await checkpointFingerprint(index,{signal:options.signal})).sha256!==node.index.sha256)throw Error("恢复的原始暂存区不一致");
    const stages=parseCheckpointIndex(await git.records(target,["ls-files","--stage","--sparse","-z"],isolatedEnv));if(JSON.stringify(stages)!==JSON.stringify(node.stages))throw Error("恢复的暂存区阶段不一致");
    const undo=parseCheckpointIndex(await git.records(target,["ls-files","--resolve-undo","-z"],isolatedEnv));if(JSON.stringify(undo)!==JSON.stringify(node.undo))throw Error("恢复的冲突撤销记录不一致");
    const flags=await git.indexFlags(target,isolatedEnv);if(JSON.stringify(flags)!==JSON.stringify(node.flags))throw Error("恢复的暂存区语义标志不一致");
    const head=await git.text(target,["rev-parse","--verify","--quiet","HEAD"],isolatedEnv).catch(error=>{if(error instanceof CheckpointGitError&&error.code===1)return undefined;throw error;});if(head!==node.head)throw Error("恢复的 Git 基线不一致");
    if(await git.text(target,["symbolic-ref","--quiet","HEAD"],isolatedEnv)!==`refs/heads/${expected.branch}`)throw Error("恢复工作区的分支已变化");
  }
  options.signal?.throwIfAborted();return{passed:true,at:Date.now()};
}
