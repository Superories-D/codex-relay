import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {CheckpointGit,CheckpointGitError} from "./checkpoint-git";
import {checkpointFingerprint,sameCheckpointPath} from "./checkpoint-file";
import type {CheckpointManifest} from "../shared/checkpoints";
import {prepareCheckpoint} from "./checkpoint-capture";
import os from "node:os";

export interface LinkedCheckpointReview {signature:string;working:string;repos:{id:string;source:string;gitDir:string;commonDir:string;identity:string;head:string;branch:string;index?:string;config?:string;worktreeConfig?:string;sharedConfig:boolean}[]}
export async function reviewLinkedCheckpoint(manifest:CheckpointManifest,scratch:string,options:{signal?:AbortSignal;native?:boolean}={}):Promise<LinkedCheckpointReview>{
  const git=new CheckpointGit(scratch,options),repos:LinkedCheckpointReview["repos"]=[];
  const optional=async(cwd:string,args:string[])=>{try{return await git.text(cwd,args);}catch(error){if(error instanceof CheckpointGitError&&error.code===1)return "";throw error;}};
  const fingerprint=async(file:string)=>{try{return (await checkpointFingerprint(file,{signal:options.signal})).sha256;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}};
  for(const node of manifest.repos){
    const source=await fs.realpath(node.source),gitDir=await fs.realpath(await git.text(source,["rev-parse","--absolute-git-dir"])),commonDir=await fs.realpath(await git.text(source,["rev-parse","--path-format=absolute","--git-common-dir"]));
    const stat=await fs.stat(commonDir,{bigint:true}),identity=[stat.dev,stat.ino].map(String).join(":");
    if(!sameCheckpointPath(source,node.source)||!sameCheckpointPath(gitDir,node.gitDir)||!sameCheckpointPath(commonDir,node.commonDir)||identity!==node.identity)throw Error("原仓库身份已变化，请选择独立恢复");
    const sharedConfig=await optional(source,["config","--bool","--get","extensions.worktreeConfig"])!=="true";
    // An existing repository without worktree-specific config keeps its normal
    // settings. Never enable an extension or replace its common configuration.
    if(sharedConfig)for(const key of ["core.filemode","core.ignorecase","core.symlinks","core.autocrlf","core.eol","core.sparsecheckout","core.sparsecheckoutcone","index.sparse","core.excludesfile"]){
      const actual=await optional(source,["config","--get",key]);if(actual!==(node.config[key]??""))throw Error("原仓库检出设置已变化，请选择独立恢复");
    }
    const index=await git.text(source,["rev-parse","--path-format=absolute","--git-path","index"]);
    repos.push({id:node.id,source,gitDir,commonDir,identity,head:await optional(source,["rev-parse","--verify","--quiet","HEAD"]),branch:await optional(source,["symbolic-ref","--quiet","HEAD"]),index:await fingerprint(index),config:await fingerprint(path.join(commonDir,"config")),worktreeConfig:await fingerprint(path.join(gitDir,"config.worktree")),sharedConfig});
  }
  // Git for Windows also bounds GIT_DIR during repository discovery. Keep
  // this disposable metadata inspection short, independently of storage depth.
  // It contains index/config evidence, never copies the working file payload.
  const temporaryParent=await fs.realpath(os.tmpdir()),temporary=await fs.mkdtemp(path.join(temporaryParent,"relay-checkpoint-review-")),claim=randomUUID();await fs.writeFile(path.join(temporary,".relay-checkpoint-review.json"),JSON.stringify({claim}),{flag:"wx",mode:0o600});
  const prepared=await prepareCheckpoint(manifest.source,"Linked restore source guard",{root:temporary,...options});
  const working=createHash("sha256").update(JSON.stringify({guards:prepared.guards.map(({path,kind,sha256,link,identity})=>({path,kind,sha256,link,identity:kind==="directory"?identity:undefined})),sources:prepared.sourceIdentity,listings:prepared.listings.map(({source,cached,others,ignored})=>({source,cached,others,ignored}))})).digest("hex");
  const physical=await fs.realpath(temporary),marker=JSON.parse(await fs.readFile(path.join(physical,".relay-checkpoint-review.json"),"utf8"));if(path.dirname(physical)!==temporaryParent||!path.basename(physical).startsWith("relay-checkpoint-review-")||(await fs.lstat(temporary)).isSymbolicLink()||marker.claim!==claim)throw Error("恢复检查临时目录归属已变化");await fs.rm(physical,{recursive:true,force:true});
  return {signature:createHash("sha256").update(JSON.stringify({repos,working})).digest("hex"),working,repos};
}
export async function assertLinkedCheckpoint(manifest:CheckpointManifest,review:LinkedCheckpointReview,scratch:string,options:{signal?:AbortSignal;native?:boolean}={}){
  const current=await reviewLinkedCheckpoint(manifest,scratch,options);if(current.signature!==review.signature)throw Error("原仓库在恢复预览后发生变化，请重新检查");return current;
}
