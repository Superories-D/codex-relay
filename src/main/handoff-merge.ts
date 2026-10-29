import {promises as fs} from "node:fs";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {checkpointOid,checkpointPath} from "../shared/checkpoints";
import {handoffConflictEntry,handoffMergeMessage,handoffMergeResult,type HandoffObjectFormat,type HandoffConflictEntry,type HandoffMergeMessage,type HandoffMergeResult} from "../shared/handoff";
import {CheckpointGit,CheckpointGitError} from "./checkpoint-git";
import {checkpointFingerprint,checkpointOutputPath} from "./checkpoint-file";
import {handoffRecords} from "./handoff-stream";

export const handoffGitEnvironment:NodeJS.ProcessEnv={
  GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",
  GIT_ATTR_NOSYSTEM:"1",GIT_NO_REPLACE_OBJECTS:"1",GIT_NAMESPACE:"",
};

export async function parseHandoffMerge(file:string,format:HandoffObjectFormat,exitCode:0|1,signal?:AbortSignal){
  const iterator=handoffRecords(file,0,signal)[Symbol.asyncIterator]();
  async function next(required=false){const value=await iterator.next();if(value.done){if(required)throw Error("交接合并结果不完整");return undefined;}return value.value;}
  try{
    const tree=checkpointOid.parse(await next(true)),oidLength=format==="sha1"?40:64;
    if(tree.length!==oidLength)throw Error("交接 Git 对象格式不一致");
    const conflicts:HandoffConflictEntry[]=[],messages:HandoffMergeMessage[]=[],seen=new Set<string>();
    if(exitCode===0){if(await next()!==undefined)throw Error("成功的交接合并包含未解释的输出");return{tree,conflicts,messages,status:"clean" as const};}
    for(;;){
      const row=await next(true);if(row==="")break;
      const match=/^(\d{6}) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(row!);if(!match)throw Error("交接冲突阶段格式无法验证");
      const entry=handoffConflictEntry.parse({mode:match[1],oid:match[2],stage:Number(match[3]),path:match[4]});
      if(entry.oid.length!==oidLength||seen.has(`${entry.stage}\0${entry.path}`))throw Error("交接冲突阶段重复或格式不一致");
      seen.add(`${entry.stage}\0${entry.path}`);conflicts.push(entry);
    }
    for(;;){
      const count=await next();if(count===undefined)break;
      if(!/^(?:0|[1-9]\d*)$/.test(count)||!Number.isSafeInteger(Number(count)))throw Error("交接冲突路径数量无法验证");
      const paths:string[]=[];for(let index=0;index<Number(count);index++)paths.push(checkpointPath.parse(await next(true)));
      messages.push(handoffMergeMessage.parse({paths,type:await next(true),text:await next(true)}));
    }
    if(!conflicts.length&&!messages.some(message=>message.type.startsWith("CONFLICT")))throw Error("交接冲突结果缺少完整证据");
    return{tree,conflicts,messages,status:"conflicted" as const};
  }finally{await iterator.return?.(undefined);}
}

/** Caller supplies an owned private repository; originals are never checked out. */
export async function computeHandoffMerge(
  git:CheckpointGit,repository:string,storage:string,
  input:{id?:string;format:HandoffObjectFormat;baseline:{kind:"checkpointWorking"|"history";oid:string};source:string;task:string},
  options:{signal?:AbortSignal;assertOwned:()=>Promise<void>}):Promise<HandoffMergeResult>{
  const id=z.string().uuid().parse(input.id||randomUUID()),oids=[input.baseline.oid,input.source,input.task].map(oid=>checkpointOid.parse(oid));
  if(oids.some(oid=>oid.length!==(input.format==="sha1"?40:64)))throw Error("交接 Git 对象格式不一致");
  await options.assertOwned();options.signal?.throwIfAborted();
  for(let index=0;index<oids.length;index++){
    const type=await git.text(repository,["cat-file","-t",oids[index]],handoffGitEnvironment);
    if(type!==(index===0&&input.baseline.kind==="history"?"commit":"tree"))throw Error("交接基准或快照的对象类型不一致");
  }
  const relative=`merges/${id}.nul`,file=await checkpointOutputPath(storage,relative);let exitCode:0|1=0;
  await options.assertOwned();
  try{await git.run(repository,["merge-tree","--write-tree","-z",`--merge-base=${input.baseline.oid}`,input.source,input.task],{env:handoffGitEnvironment,output:file});}
  catch(error){if(error instanceof CheckpointGitError&&error.code===1)exitCode=1;else throw error;}
  options.signal?.throwIfAborted();const handle=await fs.open(file,"r+");try{await handle.sync();}finally{await handle.close();}
  const before=await checkpointFingerprint(file,{signal:options.signal}),parsed=await parseHandoffMerge(file,input.format,exitCode,options.signal),after=await checkpointFingerprint(file,{signal:options.signal});
  if(before.identity!==after.identity||before.sha256!==after.sha256)throw Error("交接合并证据在读取时发生变化");
  await options.assertOwned();if(await git.text(repository,["cat-file","-t",parsed.tree],handoffGitEnvironment)!=="tree")throw Error("交接合并树无法验证");
  return handoffMergeResult.parse({version:1,...input,id,...parsed,output:{path:relative,bytes:after.bytes,sha256:after.sha256}});
}
