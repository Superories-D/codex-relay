import {promises as fs,createReadStream} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {atomicWrite} from "../core/store";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath} from "./checkpoint-file";
import {handoffRecords,handoffWriteAll} from "./handoff-stream";
import {handoffResolution,handoffResolutionInput,type HandoffResolutionInput,type HandoffWorkspace,type HandoffMergeResult} from "../shared/handoff";
import {extractHandoffBlobs,type HandoffExtractedBlob} from "./handoff-payload";
import {readHandoffWorkspace,type HandoffWorkspaceContext} from "./handoff-workspace";
import {z} from "zod";
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const text=async(context:HandoffWorkspaceContext,args:string[],options?:Parameters<HandoffWorkspaceContext["call"]>[1])=>(await context.call(args,options)).toString("utf8").trim();
async function stored(context:HandoffWorkspaceContext,relative:string){const file=await checkpointSourcePath(context.directory,relative),actual=await checkpointFingerprint(file,{signal:context.signal}),bytes=await fs.readFile(file);if(hash(bytes)!==actual.sha256)throw Error("冲突解决记录在读取时发生变化");return bytes;}

export async function readHandoffResolution(context:HandoffWorkspaceContext,id:string){
  z.string().uuid().parse(id);await context.assertOwned();
  const receipt=z.object({id:z.literal(id),sha256:z.string().regex(/^[a-f0-9]{64}$/),at:z.number().finite()}).strict().parse(JSON.parse((await stored(context,`resolutions/${id}/receipt.json`)).toString("utf8"))),json=await stored(context,`resolutions/${id}/resolution.json`);
  if(hash(json)!==receipt.sha256)throw Error("冲突解决记录完整性未通过");const result=handoffResolution.parse(JSON.parse(json.toString("utf8")));
  if(result.id!==id||result.format!==context.format||await text(context,["rev-parse","--verify",`${context.namespace}/resolutions/${id}`])!==result.tree||await text(context,["cat-file","-t",result.tree])!=="tree")throw Error("冲突解决对象固定记录不一致");return result;
}

/** Reject unedited/generated conflict markers with a streaming line-prefix scan. */
async function assertNoConflictMarkers(file:string,signal?:AbortSignal){
  let prefix=Buffer.alloc(0),atStart=true;
  for await(const chunk of createReadStream(file,{highWaterMark:256*1024})){
    signal?.throwIfAborted();const bytes=chunk as Buffer;let offset=0;
    while(offset<bytes.length){
      if(atStart){const take=Math.min(8-prefix.length,bytes.length-offset);prefix=Buffer.concat([prefix,bytes.subarray(offset,offset+take)]);offset+=take;
        const newline=prefix.indexOf(10),line=newline>=0?prefix.subarray(0,newline):prefix;
        if(line.length>=7&&["<<<<<<<","=======",">>>>>>>","|||||||"].includes(line.subarray(0,7).toString("ascii")))throw Error("手动解决文件仍包含冲突标记，请完成编辑后重试");
        if(newline>=0){offset-=prefix.length-newline-1;prefix=Buffer.alloc(0);continue;}
        if(prefix.length<8)continue;atStart=false;prefix=Buffer.alloc(0);
      }
      const newline=bytes.indexOf(10,offset);if(newline<0)break;offset=newline+1;atStart=true;
    }
  }
}

function assertChoices(input:HandoffResolutionInput,workspace:HandoffWorkspace,merge:HandoffMergeResult){
  if(workspace.state!=="needsResolution"||workspace.resolutionId||merge.status!=="conflicted")throw Error("该交接工作区没有待解决的原始冲突");
  const conflictPaths=new Set(merge.conflicts.map(entry=>entry.path)),choices=new Map(input.choices.map(choice=>[choice.path,choice]));
  if(input.strategy==="paths"){
    const supported=new Set(["CONFLICT (contents)","CONFLICT (binary)","CONFLICT (add/add)"]);
    if(!conflictPaths.size||merge.messages.some(message=>message.type.startsWith("CONFLICT")&&(!supported.has(message.type)||message.paths.some(name=>!conflictPaths.has(name)))))throw Error("结构性冲突需要明确选择完整来源树或任务树");
    if(choices.size!==input.choices.length||choices.size!==conflictPaths.size||[...choices.keys()].some(name=>!conflictPaths.has(name)))throw Error("必须逐一明确解决所有冲突路径");
  }else if(input.choices.length)throw Error("选择完整树时不能混入逐文件冲突选择");
}

/** Resolves into owned objects/new attempts; the editable candidate stays intact. */
export async function resolveHandoffWorkspace(context:HandoffWorkspaceContext,request:HandoffResolutionInput){
  const parsed=handoffResolutionInput.parse(request),input={...parsed,choices:[...parsed.choices].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)},requestSha256=hash(JSON.stringify(input));await context.assertOwned();
  try{const saved=await readHandoffResolution(context,input.id);if(saved.requestSha256!==requestSha256)throw Error("冲突解决请求已用于其他内容");return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const workspace=await readHandoffWorkspace(context,input.workspaceId),merge=await context.readMerge(workspace.mergeId);
  assertChoices(input,workspace,merge);
  const folder=path.dirname(await checkpointOutputPath(context.directory,`resolutions/${input.id}/.placeholder`)),createdAt=Date.now(),plan=await fs.open(path.join(folder,"plan.json"),"wx",0o600);
  try{await plan.writeFile(JSON.stringify({version:1,...input,requestSha256,createdAt}));await plan.sync();}finally{await plan.close();}
  let tree=input.strategy==="source"?merge.source:input.strategy==="task"?merge.task:merge.tree;
  if(input.strategy==="paths"){
    const index=path.join(folder,"index"),env={GIT_INDEX_FILE:index},info=await fs.open(path.join(folder,"index-info.nul"),"wx",0o600),zero="0".repeat(context.format==="sha1"?40:64);
    try{
      for(const choice of input.choices){
        context.signal?.throwIfAborted();await handoffWriteAll(info,`0 ${zero}\t${choice.path}\0`);
        if(choice.choice==="delete")continue;
        if(choice.choice==="working"){
          const file=await checkpointSourcePath(workspace.target,choice.path),before=await checkpointFingerprint(file,{signal:context.signal,gitFormat:context.format});
          if(before.sha256!==choice.expectedSha256||before.bytes!==choice.expectedBytes)throw Error("手动解决文件在审阅后发生变化");await assertNoConflictMarkers(file,context.signal);
          const oid=await text(context,["hash-object","--no-filters","-w","--",file]),after=await checkpointFingerprint(file,{signal:context.signal});
          if(oid!==before.gitOid||after.identity!==before.identity||after.sha256!==before.sha256)throw Error("手动解决文件在封存时发生变化");
          const entries=merge.conflicts.filter(entry=>entry.path===choice.path);if(entries.some(entry=>!["100644","100755"].includes(entry.mode)))throw Error("链接或子仓库冲突需要选择已封存对象");
          const mode=entries.find(entry=>entry.stage===2)?.mode||entries.find(entry=>entry.stage===3)?.mode||"100644";await handoffWriteAll(info,`${mode} ${oid}\t${choice.path}\0`);
        }else{
          const stage=choice.choice==="source"?2:choice.choice==="task"?3:1,entry=merge.conflicts.find(entry=>entry.path===choice.path&&entry.stage===stage);
          if(entry)await handoffWriteAll(info,`${entry.mode} ${entry.oid}\t${choice.path}\0`);
        }
      }
      await info.sync();
    }finally{await info.close();}
    await context.call(["read-tree",merge.tree],{env});await context.call(["update-index","-z","--index-info"],{env,stdinFile:path.join(folder,"index-info.nul")});tree=await text(context,["write-tree"],{env});
    // Actual unmerged index entries cannot be hidden behind a clean tree receipt.
    const stages=path.join(folder,"unmerged.nul");await context.call(["ls-files","--unmerged","-z"],{env,output:stages});for await(const unused of handoffRecords(stages,0,context.signal)){void unused;throw Error("冲突解决结果仍包含未合并索引");}
  }
  const resolution=handoffResolution.parse({version:1,...input,requestSha256,mergeId:merge.id,tree,parentCommit:workspace.commit,createdAt,format:context.format});
  await context.pin({[`resolutions/${input.id}`]:tree});context.signal?.throwIfAborted();const json=JSON.stringify(resolution);await atomicWrite(path.join(folder,"resolution.json"),json);await atomicWrite(path.join(folder,"receipt.json"),JSON.stringify({id:input.id,sha256:hash(json),at:Date.now()}));return resolution;
}

/** Rebuild from retained stage/manual objects, preserving any later workspace edits. */
export async function recoverHandoffResolution(context:HandoffWorkspaceContext,id:string){
  z.string().uuid().parse(id);await context.assertOwned();const folder=path.join(context.directory,"resolutions",id),receipt=path.join(folder,"receipt.json");let present=true;try{await fs.lstat(receipt);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;present=false;}if(present)return readHandoffResolution(context,id);
  const planBytes=await stored(context,`resolutions/${id}/plan.json`),plan=JSON.parse(planBytes.toString("utf8")),{version,requestSha256,createdAt,...rawInput}=plan,input=handoffResolutionInput.parse(rawInput),json=await stored(context,`resolutions/${id}/resolution.json`),resolution=handoffResolution.parse(JSON.parse(json.toString("utf8")));
  if(version!==1||input.id!==id||requestSha256!==hash(JSON.stringify(input))||resolution.id!==id||resolution.requestSha256!==requestSha256||resolution.createdAt!==createdAt||resolution.workspaceId!==input.workspaceId||resolution.strategy!==input.strategy||JSON.stringify(resolution.choices)!==JSON.stringify(input.choices)||resolution.format!==context.format)throw Error("中断的冲突解决记录与原始计划不一致");
  const workspace=await readHandoffWorkspace(context,input.workspaceId),merge=await context.readMerge(workspace.mergeId);assertChoices(input,workspace,merge);if(resolution.mergeId!==merge.id||resolution.parentCommit!==workspace.commit)throw Error("中断的冲突解决记录与原始计划不一致");
  const proofId=randomUUID(),proof=path.dirname(await checkpointOutputPath(context.directory,`resolutions/${id}/recoveries/${proofId}/.placeholder`)),manuals:HandoffExtractedBlob[]=[];let tree=input.strategy==="source"?merge.source:input.strategy==="task"?merge.task:merge.tree;
  if(input.strategy==="paths"){
    const index=path.join(proof,"index"),env={GIT_INDEX_FILE:index},infoFile=path.join(proof,"index-info.nul"),zero="0".repeat(context.format==="sha1"?40:64),payload=path.join(proof,"payload");await fs.mkdir(payload,{mode:0o700});const info=await fs.open(infoFile,"wx",0o600);
    try{for(const choice of input.choices){context.signal?.throwIfAborted();await handoffWriteAll(info,`0 ${zero}\t${choice.path}\0`);if(choice.choice==="delete")continue;
      if(choice.choice==="working"){
        const entries=merge.conflicts.filter(entry=>entry.path===choice.path);if(entries.some(entry=>!["100644","100755"].includes(entry.mode)))throw Error("链接或子仓库冲突需要选择已封存对象");const mode=entries.find(entry=>entry.stage===2)?.mode||entries.find(entry=>entry.stage===3)?.mode||"100644",row=(await context.call(["--literal-pathspecs","ls-tree","-z",resolution.tree,"--",choice.path])).toString("utf8"),match=/^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(row);
        if(!match||match[1]!==mode||match[3]!==choice.path)throw Error("中断的冲突解决树与完整重建结果不一致");const oid=match[2];await context.call(["cat-file","--batch"],{input:oid+"\n",consumeOutput:async stream=>{manuals.push(...await extractHandoffBlobs(stream,context.format,payload,[{path:choice.path,oid,mode:mode as "100644"|"100755",kind:"file",materialize:true,expectedBytes:choice.expectedBytes,expectedSha256:choice.expectedSha256}],{signal:context.signal,progress:(name,bytes)=>context.progress?.({phase:"verifying",path:name,bytes,files:manuals.length,totalFiles:input.choices.length})}));}});await assertNoConflictMarkers(await checkpointSourcePath(payload,choice.path),context.signal);await handoffWriteAll(info,`${mode} ${oid}\t${choice.path}\0`);
      }else{const stage=choice.choice==="source"?2:choice.choice==="task"?3:1,entry=merge.conflicts.find(entry=>entry.path===choice.path&&entry.stage===stage);if(entry)await handoffWriteAll(info,`${entry.mode} ${entry.oid}\t${choice.path}\0`);}
    }await info.sync();}finally{await info.close();}
    await context.call(["read-tree",merge.tree],{env});await context.call(["update-index","-z","--index-info"],{env,stdinFile:infoFile});tree=await text(context,["write-tree"],{env});
  }
  if(tree!==resolution.tree)throw Error("中断的冲突解决树与完整重建结果不一致");if(!(await stored(context,`resolutions/${id}/plan.json`)).equals(planBytes)||!(await stored(context,`resolutions/${id}/resolution.json`)).equals(json))throw Error("中断的冲突解决记录在核对期间发生变化");
  context.signal?.throwIfAborted();await context.assertOwned();await atomicWrite(path.join(proof,"proof.json"),JSON.stringify({version:1,id,proofId,requestSha256,sha256:hash(json),tree,manuals,at:Date.now()}));await context.pin({[`resolutions/${id}`]:tree});let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{handle=await fs.open(receipt,"wx",0o600);await handle.writeFile(JSON.stringify({id,sha256:hash(json),at:Date.now()}));await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{await handle?.close();}return readHandoffResolution(context,id);
}
