import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import type {CheckpointManifest,CheckpointRepo} from "../shared/checkpoints";
import type {HandoffEntry,HandoffProgress,HandoffRole,HandoffResolutionInput} from "../shared/handoff";
import {handoffGraphRecord,handoffGraphPointer,handoffGraphRoles,type HandoffGraphNode,type HandoffGraphRecord,type HandoffGraphPointer} from "../shared/handoff-graph";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath,sameCheckpointPath} from "./checkpoint-file";
import {HandoffRepository} from "./handoff-repository";
import type {HandoffAttachment} from "../shared/handoff-assembly";
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex"),fold=(value:string)=>value.toLowerCase();
type Archives=Record<HandoffRole,Awaited<ReturnType<HandoffRepository["archiveMetadata"]>>>;
type Options={native?:boolean;signal?:AbortSignal;progress?:(value:HandoffProgress)=>void};
function parent(manifest:CheckpointManifest,relative:string){return manifest.repos.filter(node=>node.relative!==relative&&(!node.relative||relative.startsWith(node.relative+"/"))).sort((a,b)=>b.relative.length-a.relative.length)[0];}
/** Union every captured repository and uninitialized gitlink, without flattening. */
function topology(archives:Archives){
  const rows=new Map<string,Pick<HandoffGraphNode,"path"|"roles"|"kind"|"issues"|"format">>();
  const row=(name:string)=>{const key=fold(name);let value=rows.get(key);if(!value){value={path:name,roles:{},kind:"nested",issues:[]};rows.set(key,value);}return value;};
  for(const role of handoffGraphRoles){const manifest=archives[role].manifest;
    for(const node of manifest.repos.filter(value=>value.relative)){
      const container=parent(manifest,node.relative);if(!container)throw Error("子仓库缺少可验证的父仓库");const local=container.relative?node.relative.slice(container.relative.length+1):node.relative,gitlinks=container.stages.filter(stage=>stage.path===local&&stage.mode==="160000").map(({stage,oid})=>({stage,oid})),value=row(node.relative);
      if(value.roles[role])throw Error("子仓库路径在同一封存中重复");value.roles[role]={repositoryId:node.id,relative:node.relative,parentRelative:container.relative,tracked:gitlinks.length>0,format:node.format,head:node.head,source:node.source,gitlinks};
    }
    for(const container of manifest.repos)for(const stage of container.stages.filter(value=>value.mode==="160000")){
      const name=container.relative?`${container.relative}/${stage.path}`:stage.path,value=row(name);if(value.roles[role]?.repositoryId)continue;const member=value.roles[role];if(member){if(member.relative!==name)throw Error("子仓库路径在同一封存中重复");member.gitlinks.push({stage:stage.stage,oid:stage.oid});}else value.roles[role]={relative:name,parentRelative:container.relative,tracked:true,gitlinks:[{stage:stage.stage,oid:stage.oid}]};
    }
  }
  for(const value of rows.values()){
    const members=handoffGraphRoles.map(role=>value.roles[role]),initialized=members.filter(member=>member?.repositoryId),tracked=members.filter(Boolean).map(member=>member!.tracked);
    value.kind=tracked.every(Boolean)?"submodule":tracked.every(value=>!value)?"nested":"mixed";
    for(const [role,issue]of [["base","missingBase"],["source","missingSource"],["task","missingTask"]]as const)if(!value.roles[role]?.repositoryId)value.issues.push(issue);
    if(new Set(members.filter(Boolean).map(member=>member!.relative)).size>1)value.issues.push("pathCaseConflict");
    if(new Set(initialized.map(member=>member!.format)).size>1)value.issues.push("formatMismatch");else value.format=initialized[0]?.format;
    if(new Set(members.filter(Boolean).map(member=>member!.parentRelative)).size>1)value.issues.push("topologyChange");if(value.kind==="mixed")value.issues.push("trackingChange");
    if(handoffGraphRoles.some(role=>{const member=value.roles[role];return member?.repositoryId&&!archives[role].manifest.repos.find(node=>node.id===member.repositoryId)?.pack;}))value.issues.push("missingHistory");
  }
  return[...rows.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
async function archives(root:HandoffRepository,entry:Pick<HandoffEntry,"archives">):Promise<Archives>{const result={}as Archives;for(const role of handoffGraphRoles){const saved=await root.archiveMetadata(entry.archives[role]);if(saved.archive.role!==role)throw Error("子仓库图与交接封存不一致");result[role]=saved;}return result;}
function children(manifest:CheckpointManifest,node:CheckpointRepo){const links:Record<string,string>={};for(const child of manifest.repos){const container=child.relative?parent(manifest,child.relative):undefined;if(container?.id!==node.id)continue;const local=node.relative?child.relative.slice(node.relative.length+1):child.relative;if(node.stages.some(stage=>stage.path===local&&stage.mode==="160000")&&child.head)links[local]=child.head;}return links;}
export async function writeHandoffGraph(root:HandoffRepository,record:HandoffGraphRecord):Promise<HandoffGraphPointer>{
  handoffGraphRecord.parse(record);await root.assertOwned();const json=JSON.stringify(record),sha256=hash(json),file=await checkpointOutputPath(root.directory,`graphs/${record.id}/records/${sha256}.json`);let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{handle=await fs.open(file,"wx",0o600);await handle.writeFile(json);await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{await handle?.close();}if((await checkpointFingerprint(file)).sha256!==sha256)throw Error("子仓库图记录完整性未通过");return{id:record.id,sha256,total:record.nodes.length};
}
export async function readHandoffGraph(root:HandoffRepository,entry:Pick<HandoffEntry,"id"|"archives">,owner:string,pointer:HandoffGraphPointer){
  handoffGraphPointer.parse(pointer);await root.assertOwned();const file=await checkpointSourcePath(root.directory,`graphs/${pointer.id}/records/${pointer.sha256}.json`),before=await checkpointFingerprint(file),bytes=await fs.readFile(file);if(before.sha256!==pointer.sha256||hash(bytes)!==pointer.sha256)throw Error("子仓库图记录完整性未通过");const record=handoffGraphRecord.parse(JSON.parse(bytes.toString("utf8")));
  if(record.id!==pointer.id||record.owner!==owner||record.entryId!==entry.id||record.nodes.length!==pointer.total||new Set(record.nodes.map(node=>node.id)).size!==record.nodes.length)throw Error("子仓库图不属于当前交接");
  const sources=await archives(root,entry),expected=topology(sources);for(const role of handoffGraphRoles)if(record.archives[role].id!==sources[role].archive.id||record.archives[role].manifestSha256!==sources[role].archive.manifestSha256)throw Error("子仓库图与交接封存不一致");
  const comparable=(node:Pick<HandoffGraphNode,"path"|"roles"|"kind"|"issues"|"format">)=>JSON.stringify({path:node.path,roles:node.roles,kind:node.kind,issues:node.issues,format:node.format});if(record.nodes.length!==expected.length||record.nodes.some((node,index)=>comparable(node)!==comparable(expected[index])))throw Error("子仓库图与完整仓库拓扑不一致");return{record,sources};
}
export async function openHandoffGraphNode(root:HandoffRepository,record:HandoffGraphRecord,node:HandoffGraphNode,options:Options={}){await root.assertOwned();if(node.issues.length||!node.currentWorkspaceId||!node.format||!record.nodes.some(value=>value.id===node.id))throw Error("子仓库需要先明确来源和仓库格式");return HandoffRepository.open(path.join(root.directory,"children",node.id),{owner:record.owner,id:node.id},options);}
/** After assembly, review the mounted copy that acceptance will read.
 * The immutable graph still records the independent candidate's provenance. */
export async function graphReviewWorkspace(root:HandoffRepository,entry:HandoffEntry,record:HandoffGraphRecord,node:HandoffGraphNode,options:Options={}){
  const repository=await openHandoffGraphNode(root,record,node,options);
  if(!entry.assembly)return{repository,workspaceId:node.currentWorkspaceId!,assembled:false};
  if(entry.assembly.graphSha256!==entry.graph?.sha256||entry.assembly.workspaceId!==entry.currentWorkspaceId)throw Error("组装恢复计划与当前候选不一致");
  let parentWorkspace=await root.readWorkspace(entry.currentWorkspaceId!),relative=node.path,parentRelative="";
  const visited=new Set<string>();for(;;){
    options.signal?.throwIfAborted();const attachment=parentWorkspace.attachments?.filter(value=>relative===value.path||relative.startsWith(value.path+"/")).sort((left,right)=>right.path.length-left.path.length)[0];
    if(!attachment||visited.has(attachment.repositoryId))throw Error("组装子仓库与核验记录不一致");visited.add(attachment.repositoryId);
    const full=parentRelative?`${parentRelative}/${attachment.path}`:attachment.path,child=record.nodes.find(value=>value.id===attachment.repositoryId&&value.path===full);if(!child)throw Error("组装子仓库与核验记录不一致");
    const childRepository=child.id===node.id?repository:await openHandoffGraphNode(root,record,child,options),workspace=await childRepository.readWorkspace(attachment.workspaceId);
    if(workspace.commit!==attachment.commit||workspace.tree!==attachment.tree||workspace.replica?.sourceWorkspaceId!==attachment.sourceWorkspaceId||!sameCheckpointPath(workspace.target,path.join(parentWorkspace.target,...attachment.path.split("/"))))throw Error("组装子仓库与核验记录不一致");
    if(full===node.path){if(child.id!==node.id)throw Error("组装子仓库与核验记录不一致");return{repository:childRepository,workspaceId:workspace.id,assembled:true};}
    parentWorkspace=workspace;parentRelative=full;relative=node.path.slice(full.length+1);
  }
}
/** Create real independent child proposals from retained archives, never child HEAD alone. */
export async function createHandoffGraph(root:HandoffRepository,entry:Pick<HandoffEntry,"id"|"archives">,owner:string,options:Options={}){
  z.string().uuid().parse(owner);await root.assertOwned();const sources=await archives(root,entry),rows=topology(sources);if(!rows.length)return undefined;
  const id=randomUUID(),record:HandoffGraphRecord={version:1,id,owner,entryId:entry.id,createdAt:Date.now(),archives:{base:{id:entry.archives.base,manifestSha256:sources.base.archive.manifestSha256},source:{id:entry.archives.source,manifestSha256:sources.source.archive.manifestSha256},task:{id:entry.archives.task,manifestSha256:sources.task.archive.manifestSha256}},nodes:rows.map(value=>({...value,id:randomUUID(),snapshots:{base:randomUUID(),source:randomUUID(),task:randomUUID()},mergeId:randomUUID(),initialWorkspaceId:randomUUID(),workspaceIds:[],resolutionAttempts:[],status:"needsChoice"}))};
  const plan=await checkpointOutputPath(root.directory,`graphs/${id}/plan.json`),handle=await fs.open(plan,"wx",0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
  for(const node of record.nodes){options.signal?.throwIfAborted();if(node.issues.length)continue;const folder=path.dirname(await checkpointOutputPath(root.directory,"children/.placeholder")),repository=await HandoffRepository.create(path.join(folder,node.id),{owner,id:node.id,format:node.format!,family:{directory:root.directory,id:entry.id,owner},sourceRoots:handoffGraphRoles.flatMap(role=>[sources[role].manifest.source,node.roles[role]!.source!])},options),snapshots=[];
    for(const role of handoffGraphRoles){const saved=sources[role],member=node.roles[role]!,captured=saved.manifest.repos.find(value=>value.id===member.repositoryId)!;snapshots.push(await repository.snapshot({id:node.snapshots[role],role,root:saved.root,manifestSha256:saved.archive.manifestSha256,repositoryId:captured.id,gitlinks:children(saved.manifest,captured)}));}
    const [base,source,task]=snapshots,merge=await repository.merge({id:node.mergeId,baseline:{kind:"checkpointWorking",oid:base.tree},source:source.tree,task:task.tree}),workspace=await repository.createWorkspace({id:node.initialWorkspaceId,mergeId:merge.id,baselineSnapshotId:base.id,sourceSnapshotId:source.id,taskSnapshotId:task.id});node.currentWorkspaceId=workspace.id;node.workspaceIds.push(workspace.id);node.status=workspace.state;
  }
  options.signal?.throwIfAborted();return writeHandoffGraph(root,record);
}

export async function resolveHandoffGraph(root:HandoffRepository,entry:HandoffEntry,owner:string,value:{nodeId:string;graphSha256:string;requestId:string;resolution:HandoffResolutionInput;requestSha256:string},options:Options={}){
  if(!entry.graph||entry.graph.sha256!==value.graphSha256)throw Error("子仓库审阅版本已变化，请重新读取");const {record}=await readHandoffGraph(root,entry,owner,entry.graph),node=record.nodes.find(node=>node.id===value.nodeId);if(!node)throw Error("子仓库不属于当前交接图");if(node.currentWorkspaceId!==value.resolution.workspaceId)throw Error("冲突解决指向的交接工作区已变化");
  const repository=await openHandoffGraphNode(root,record,node,options),resolution=await repository.resolveWorkspace(value.resolution),workspace=await repository.createWorkspace({id:value.requestId,mergeId:node.mergeId,sourceSnapshotId:node.snapshots.source,taskSnapshotId:node.snapshots.task,baselineSnapshotId:node.snapshots.base,resolutionId:resolution.id});
  node.resolutionAttempts.push({workspaceId:workspace.id,sourceWorkspaceId:value.resolution.workspaceId,resolutionId:resolution.id,requestSha256:value.requestSha256});node.workspaceIds.push(workspace.id);node.currentWorkspaceId=workspace.id;node.status=workspace.state;options.signal?.throwIfAborted();return writeHandoffGraph(root,record);
}
/** Recover a committed private child result whose catalog pointer was not saved. */
export async function recoverHandoffGraphResolution(root:HandoffRepository,entry:HandoffEntry,owner:string,options:Options={}){
  const pending=entry.pendingGraph;if(!pending||!entry.graph||pending.graphSha256!==entry.graph.sha256)throw Error("子仓库恢复计划与当前交接不一致");const {record}=await readHandoffGraph(root,entry,owner,entry.graph),node=record.nodes.find(node=>node.id===pending.nodeId);if(!node||node.currentWorkspaceId!==pending.sourceWorkspaceId)throw Error("子仓库恢复计划与当前交接不一致");const repository=await openHandoffGraphNode(root,record,node,options);await repository.recoverResolution(pending.resolutionId);const workspace=await repository.recoverWorkspace(pending.id);if(workspace.resolutionId!==pending.resolutionId||!(await repository.verifyWorkspace(workspace.id)).unchanged)throw Error("中断的交接目标已发生变化，原文件已保留，请创建新目标");
  node.resolutionAttempts.push({workspaceId:workspace.id,sourceWorkspaceId:pending.sourceWorkspaceId,resolutionId:pending.resolutionId,requestSha256:pending.requestSha256});node.workspaceIds.push(workspace.id);node.currentWorkspaceId=workspace.id;node.status=workspace.state;options.signal?.throwIfAborted();return writeHandoffGraph(root,record);
}

/** Build descendants first, then mount immutable replicas into a fresh parent. */
export async function assembleHandoffGraph(root:HandoffRepository,entry:HandoffEntry,owner:string,input:{requestId:string;graphSha256?:string;workspaceId:string;setup:"base"|"source"|"task"|"omit"},options:Options={}){
  if(!entry.graph){
    if(input.graphSha256||entry.currentWorkspaceId!==input.workspaceId)throw Error("子仓库审阅版本已变化，请重新读取");
    const original=await root.readWorkspace(input.workspaceId);if(!original.dependencies.some(value=>value.kind==="ignoredSetup"))throw Error("当前候选没有等待接入的忽略配置");
    const composition=await root.composeWorkspace({id:randomUUID(),baseWorkspaceId:original.id,attachments:[],setup:{choice:input.setup,archives:entry.archives}}),workspace=await root.createWorkspace({id:input.requestId,mergeId:original.mergeId,baselineSnapshotId:original.baselineSnapshotId,sourceSnapshotId:original.sourceSnapshotId,taskSnapshotId:original.taskSnapshotId,resolutionId:original.resolutionId,compositionId:composition.id});
    if(workspace.state!=="reviewable"||!(await root.verifyWorkspace(workspace.id)).unchanged)throw Error("组装候选未通过完整复核");options.signal?.throwIfAborted();return{workspace,graph:undefined,assembled:[]};
  }
  if(!entry.graph||entry.graph.sha256!==input.graphSha256||entry.currentWorkspaceId!==input.workspaceId)throw Error("子仓库审阅版本已变化，请重新读取");const {record}=await readHandoffGraph(root,entry,owner,entry.graph);if(record.nodes.some(node=>node.issues.length||!node.currentWorkspaceId||node.status==="needsResolution"))throw Error("请先明确所有子仓库来源并解决冲突");
  const selected=new Map<string,{repository:HandoffRepository;workspace:Awaited<ReturnType<HandoffRepository["readWorkspace"]>>}>(),assembled=[]as {path:string;workspaceId:string;commit:string}[];
  for(const node of record.nodes){const repository=await openHandoffGraphNode(root,record,node,options),workspace=await repository.readWorkspace(node.currentWorkspaceId!);if(workspace.state==="needsResolution"||!(await repository.verifyWorkspace(workspace.id)).unchanged)throw Error("组装前请解决冲突并核对原始候选");selected.set(node.path,{repository,workspace});}
  async function compose(repository:HandoffRepository,workspace:Awaited<ReturnType<HandoffRepository["readWorkspace"]>>,relative:string,id:string){
    const children=record.nodes.filter(node=>node.roles.source?.parentRelative===relative);if(!children.length&&!workspace.dependencies.some(value=>value.kind==="ignoredSetup"))return workspace;const attachments:HandoffAttachment[]=[];
    for(const node of children){const child=selected.get(node.path)!;if(child.workspace.state!=="reviewable")throw Error("请先明确所有子仓库来源并解决冲突");attachments.push({path:relative?node.path.slice(relative.length+1):node.path,kind:node.kind==="submodule"?"submodule":"nested",repositoryId:node.id,sourceWorkspaceId:child.workspace.id,workspaceId:randomUUID(),commit:child.workspace.commit,tree:child.workspace.tree,sourceSha256:hash(JSON.stringify(child.workspace))});}
    const composition=await repository.composeWorkspace({id:randomUUID(),baseWorkspaceId:workspace.id,attachments,setup:{choice:input.setup,archives:entry.archives}});return repository.createWorkspace({id,mergeId:workspace.mergeId,baselineSnapshotId:workspace.baselineSnapshotId,sourceSnapshotId:workspace.sourceSnapshotId,taskSnapshotId:workspace.taskSnapshotId,resolutionId:workspace.resolutionId,compositionId:composition.id});
  }
  for(const node of [...record.nodes].sort((a,b)=>b.path.split("/").length-a.path.split("/").length)){options.signal?.throwIfAborted();const selectedNode=selected.get(node.path)!,workspace=await compose(selectedNode.repository,selectedNode.workspace,node.path,randomUUID());if(workspace.state!=="reviewable")throw Error("请先明确所有子仓库来源并解决冲突");selectedNode.workspace=workspace;assembled.push({path:node.path,workspaceId:workspace.id,commit:workspace.commit});}
  const original=await root.readWorkspace(input.workspaceId),workspace=await compose(root,original,"",input.requestId);if(workspace.id!==input.requestId||workspace.state!=="reviewable"||!(await root.verifyWorkspace(workspace.id)).unchanged)throw Error("组装候选未通过完整复核");options.signal?.throwIfAborted();return{workspace,graph:entry.graph,assembled};
}
