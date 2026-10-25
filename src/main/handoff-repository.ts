import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {checkpointManifest,checkpointOid,checkpointPath,type CheckpointManifest,type CheckpointRepo,type CheckpointIndexEntry} from "../shared/checkpoints";
import {handoffObjectFormat,handoffRole,handoffTreeSnapshot,handoffMergeResult,type HandoffMergeResult,type HandoffObjectFormat,type HandoffRole,type HandoffTreeMember,type HandoffTreeSnapshot,type HandoffProgress} from "../shared/handoff";
import {CheckpointGit,CheckpointGitError} from "./checkpoint-git";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath,insideCheckpoint,sameCheckpointPath} from "./checkpoint-file";
import {computeHandoffMerge,parseHandoffMerge,handoffGitEnvironment} from "./handoff-merge";
import {handoffRecords,handoffWriteAll} from "./handoff-stream";
import {createHandoffWorkspace,readHandoffWorkspace,recoverHandoffWorkspace,verifyHandoffWorkspace,type HandoffWorkspaceContext,type HandoffWorkspaceInput} from "./handoff-workspace";
import {createHandoffComposition,readHandoffComposition,replicateHandoffWorkspace} from "./handoff-composition";
import type {HandoffAttachment} from "../shared/handoff-assembly";
import {readHandoffResolution,resolveHandoffWorkspace,recoverHandoffResolution} from "./handoff-resolution";
import type {HandoffResolutionInput} from "../shared/handoff";
import {retainHandoffArchive,readHandoffArchive,recoverHandoffArchive,type HandoffArchiveInput} from "./handoff-archive";
import {readHandoffContent} from "./handoff-content";
import {handoffContentSelection,type HandoffContentSelection,type HandoffEntry} from "../shared/handoff";

const repositoryFamily=z.object({directory:z.string(),id:z.string().uuid(),owner:z.string().uuid()}).strict();
const repositoryMarker=z.object({version:z.literal(1),owner:z.string().uuid(),id:z.string().uuid(),format:handoffObjectFormat,identity:z.string(),gitIdentity:z.string(),configSha256:z.string().regex(/^[a-f0-9]{64}$/),family:repositoryFamily.optional()}).strict();
type RepositoryMarker=z.infer<typeof repositoryMarker>;
type Options={signal?:AbortSignal;native?:boolean;progress?:(value:HandoffProgress)=>void};
type SnapshotInput={id:string;role:HandoffRole;root:string;manifestSha256:string;repositoryId:string;gitlinks?:Record<string,string>};
type MergeInput={id?:string;baseline:{kind:"checkpointWorking"|"history";oid:string};source:string;task:string};
const mutationQueues=new Map<string,Promise<void>>();
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
async function directoryId(folder:string){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("交接仓库目录归属已变化");return[stat.dev,stat.ino].map(String).join(":");}

/** Private object database. No public method checks out or updates source refs. */
export class HandoffRepository {
  private readonly git:CheckpointGit;
  private constructor(readonly directory:string,private marker:RepositoryMarker,private options:Options){this.git=new CheckpointGit(path.join(directory,"commands"),options);}
  static async create(directory:string,input:{owner:string;id:string;format:HandoffObjectFormat;sourceRoots:string[];family?:z.infer<typeof repositoryFamily>},options:Options={}){
    z.string().uuid().parse(input.owner);z.string().uuid().parse(input.id);handoffObjectFormat.parse(input.format);
    const parent=await fs.realpath(path.dirname(directory));if(!sameCheckpointPath(parent,path.dirname(directory)))throw Error("交接存储目录已变化");
    for(const source of input.sourceRoots){if(!path.isAbsolute(source))throw Error("交接源仓库路径必须是绝对路径");const canonical=await fs.realpath(source).catch(error=>{if(error.code==="ENOENT")return source;throw error;});for(const candidate of [source,canonical])if(sameCheckpointPath(candidate,directory)||insideCheckpoint(candidate,directory))throw Error("交接存储必须位于源工作区之外");}
    options.signal?.throwIfAborted();await fs.mkdir(directory,{mode:0o700});await directoryId(directory);
    const git=new CheckpointGit(path.join(directory,"commands"),options),template=path.join(directory,"empty-template");await fs.mkdir(template);
    await atomicWrite(path.join(directory,"creation-plan.json"),JSON.stringify({version:1,...input}));
    await git.run(parent,["init",`--object-format=${input.format}`,`--template=${template}`,directory],{env:handoffGitEnvironment});
    const empty=path.join(directory,"empty-attributes");await fs.writeFile(empty,"",{flag:"wx",mode:0o600});
    for(const [key,value]of [["core.autocrlf","false"],["core.attributesfile",empty],["core.excludesfile",empty],["extensions.worktreeConfig","true"]])await git.run(directory,["config",key,value],{env:handoffGitEnvironment});
    const marker:RepositoryMarker={version:1,owner:input.owner,id:input.id,format:input.format,identity:await directoryId(directory),gitIdentity:await directoryId(path.join(directory,".git")),configSha256:(await checkpointFingerprint(path.join(directory,".git/config"))).sha256,...(input.family?{family:repositoryFamily.parse(input.family)}:{})};
    await atomicWrite(path.join(directory,".relay-handoff-repository.json"),JSON.stringify(marker));return new HandoffRepository(directory,marker,options);
  }
  static async open(directory:string,identity:{owner:string;id:string},options:Options={}){
    const marker=repositoryMarker.parse(JSON.parse(await fs.readFile(path.join(directory,".relay-handoff-repository.json"),"utf8")));
    if(marker.owner!==identity.owner||marker.id!==identity.id)throw Error("交接仓库不属于当前操作");const repo=new HandoffRepository(directory,marker,options);await repo.assertOwned();return repo;
  }
  async assertOwned(){
    this.options.signal?.throwIfAborted();const current=repositoryMarker.parse(JSON.parse(await fs.readFile(path.join(this.directory,".relay-handoff-repository.json"),"utf8")));
    if(JSON.stringify(current)!==JSON.stringify(this.marker)||await directoryId(this.directory)!==this.marker.identity||await directoryId(path.join(this.directory,".git"))!==this.marker.gitIdentity||(await checkpointFingerprint(path.join(this.directory,".git/config"))).sha256!==this.marker.configSha256)throw Error("交接仓库配置或归属已变化");
    if(this.marker.family){const family=this.marker.family;if(!path.isAbsolute(family.directory)||family.owner!==this.marker.owner||!sameCheckpointPath(this.directory,path.join(family.directory,"children",this.marker.id)))throw Error("子仓库不属于当前交接图");const parent=await HandoffRepository.open(family.directory,{owner:family.owner,id:family.id},this.options);if(parent.marker.family)throw Error("子仓库不属于当前交接图");}
    await directoryId(path.join(this.directory,".git/objects"));
    try{const alternates=await fs.readFile(path.join(this.directory,".git/objects/info/alternates"),"utf8");if(alternates.trim())throw Error("交接仓库依赖了外部对象目录");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  private async call(args:string[],options:Parameters<CheckpointGit["run"]>[2]={}){await this.assertOwned();return this.git.run(this.directory,args,{...options,env:{...handoffGitEnvironment,...options.env}});}
  private async text(args:string[],options:Parameters<CheckpointGit["run"]>[2]={}){return(await this.call(args,options)).toString("utf8").trim();}
  private mutate<T>(action:()=>Promise<T>){const key=process.platform==="win32"?path.resolve(this.directory).toLowerCase():path.resolve(this.directory),previous=mutationQueues.get(key)||Promise.resolve(),operation=previous.then(()=>{this.options.signal?.throwIfAborted();return action();}),tail=operation.then(()=>{},()=>{});mutationQueues.set(key,tail);void tail.then(()=>{if(mutationQueues.get(key)===tail)mutationQueues.delete(key);});return operation;}
  private workspaceContext():HandoffWorkspaceContext{return{directory:this.directory,familyRoot:this.marker.family?.directory||this.directory,format:this.marker.format,namespace:`refs/codex-relay/handoff/${this.marker.id}`,signal:this.options.signal,progress:this.options.progress,assertOwned:()=>this.assertOwned(),call:(args,options)=>this.call(args,options),readSnapshot:id=>this.readSnapshot(id),readMerge:id=>this.readMerge(id),readResolution:id=>this.readResolution(id),readComposition:id=>readHandoffComposition(this.workspaceContext(),id),attachmentRepository:id=>this.attachmentRepository(id),archiveMetadata:id=>this.familyArchiveMetadata(id),pin:refs=>this.pinNow(refs)};}
  private async attachmentRepository(id:string){z.string().uuid().parse(id);await this.assertOwned();const family=this.marker.family||{directory:this.directory,id:this.marker.id,owner:this.marker.owner},repository=await HandoffRepository.open(path.join(family.directory,"children",id),{owner:family.owner,id},this.options);if(JSON.stringify(repository.marker.family)!==JSON.stringify(family))throw Error("子仓库不属于当前交接图");return repository;}
  private async familyArchiveMetadata(id:string){if(!this.marker.family)return this.archiveMetadata(id);const root=await HandoffRepository.open(this.marker.family.directory,{owner:this.marker.family.owner,id:this.marker.family.id},this.options);return root.archiveMetadata(id);}
  async composeWorkspace(input:{id:string;baseWorkspaceId:string;attachments:HandoffAttachment[];setup?:{choice:"base"|"source"|"task"|"omit";archives:Pick<HandoffEntry,"archives">["archives"]}}){return this.mutate(()=>createHandoffComposition(this.workspaceContext(),input));}
  async readComposition(id:string){return readHandoffComposition(this.workspaceContext(),id);}
  async replicateWorkspace(input:{id:string;sourceWorkspaceId:string;parentRoot:string;relative:string}){return this.mutate(()=>replicateHandoffWorkspace(this.workspaceContext(),input));}
  async createWorkspace(input:HandoffWorkspaceInput){return this.mutate(()=>createHandoffWorkspace(this.workspaceContext(),input));}
  async readWorkspace(id:string){return readHandoffWorkspace(this.workspaceContext(),id);}
  async verifyWorkspace(id:string){return verifyHandoffWorkspace(this.workspaceContext(),await this.readWorkspace(id));}
  async recoverWorkspace(id:string){return this.mutate(()=>recoverHandoffWorkspace(this.workspaceContext(),id));}
  async resolveWorkspace(input:HandoffResolutionInput){return this.mutate(()=>resolveHandoffWorkspace(this.workspaceContext(),input));}
  async readResolution(id:string){return readHandoffResolution(this.workspaceContext(),id);}
  async recoverResolution(id:string){return this.mutate(()=>recoverHandoffResolution(this.workspaceContext(),id));}
  async retainArchive(input:HandoffArchiveInput){return this.mutate(()=>retainHandoffArchive(this.workspaceContext(),input));}
  async readArchive(id:string){return readHandoffArchive(this.workspaceContext(),id);}
  async recoverArchive(id:string){return this.mutate(()=>recoverHandoffArchive(this.workspaceContext(),id));}
  async archiveMetadata(id:string){return readHandoffArchive(this.workspaceContext(),id,{verifyPayload:false});}
  async readContent(entry:Pick<HandoffEntry,"archives"|"snapshots"|"currentWorkspaceId">,selection:HandoffContentSelection,archiveMetadata?:(id:string)=>ReturnType<HandoffRepository["archiveMetadata"]>){return readHandoffContent({...this.workspaceContext(),readWorkspace:id=>this.readWorkspace(id),archiveMetadata:archiveMetadata||((id:string)=>this.archiveMetadata(id))},entry,handoffContentSelection.parse(selection));}
  async snapshotArchive(input:{id:string;archiveId:string;repositoryId:string;gitlinks?:Record<string,string>}){const saved=await this.readArchive(input.archiveId);return this.snapshot({id:input.id,role:saved.archive.role,root:saved.root,manifestSha256:saved.archive.manifestSha256,repositoryId:input.repositoryId,gitlinks:input.gitlinks});}
  private async ownedBytes(relative:string){const file=await checkpointSourcePath(this.directory,relative),actual=await checkpointFingerprint(file,{signal:this.options.signal}),bytes=await fs.readFile(file);if(hash(bytes)!==actual.sha256)throw Error("交接记录在读取时发生变化");return bytes;}
  private async manifest(root:string,expectedSha256:string){
    const file=await checkpointSourcePath(root,"manifest.json"),before=await checkpointFingerprint(file,{signal:this.options.signal});if(before.sha256!==expectedSha256)throw Error("交接快照清单完整性未通过");
    const bytes=await fs.readFile(file);if(hash(bytes)!==expectedSha256)throw Error("交接快照清单在读取时发生变化");return checkpointManifest.parse(JSON.parse(bytes.toString("utf8")));
  }
  private async verifyMembers(tree:string,members:HandoffTreeMember[]){
    const output=await checkpointOutputPath(this.directory,`verifications/${randomUUID()}.nul`);await this.call(["ls-tree","-r","-z",tree],{output});const remaining=new Map(members.map(member=>[member.path,member]));
    if(remaining.size!==members.length)throw Error("交接文件清单存在重复路径");
    for await(const record of handoffRecords(output,0,this.options.signal)){const match=/^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record),member=match?remaining.get(match[3]):undefined;if(!match||!member||member.mode!==match[1]||member.oid!==match[2])throw Error("交接 Git 树与完整文件清单不一致");remaining.delete(match[3]);}if(remaining.size)throw Error("交接 Git 树缺少已记录的文件");
  }
  private async indexEntries(node:CheckpointRepo,folder:string){
    const indexed=new Map<string,CheckpointIndexEntry>(node.stages.filter(stage=>stage.stage===0&&stage.mode!=="040000").map(stage=>[stage.path,stage]));
    for(const sparse of node.stages.filter(stage=>stage.stage===0&&stage.mode==="040000")){
      const output=path.join(folder,`sparse-${randomUUID()}.nul`);await this.call(["ls-tree","-r","-z",sparse.oid],{output});
      for await(const record of handoffRecords(output,0,this.options.signal)){const match=/^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);if(!match)throw Error("稀疏交接索引无法验证");const name=sparse.path.replace(/\/$/,"")+"/"+match[4];checkpointPath.parse(name);indexed.set(name,{path:name,mode:match[1] as CheckpointIndexEntry["mode"],oid:match[3],stage:0});}
    }
    return indexed;
  }
  async readSnapshot(id:string){
    z.string().uuid().parse(id);await this.assertOwned();const receipt=z.object({id:z.literal(id),tree:checkpointOid,sha256:z.string().regex(/^[a-f0-9]{64}$/),completedAt:z.number().finite()}).strict().parse(JSON.parse((await this.ownedBytes(`snapshots/${id}/snapshot-receipt.json`)).toString("utf8")));
    const json=await this.ownedBytes(`snapshots/${id}/snapshot.json`);if(hash(json)!==receipt.sha256)throw Error("交接快照记录完整性未通过");const snapshot=handoffTreeSnapshot.parse(JSON.parse(json.toString("utf8")));
    if(snapshot.id!==id||snapshot.tree!==receipt.tree||snapshot.format!==this.marker.format||await this.text(["rev-parse","--verify",`refs/codex-relay/handoff/${this.marker.id}/snapshots/${id}`])!==snapshot.tree)throw Error("交接快照对象固定记录不一致");await this.verifyMembers(snapshot.tree,snapshot.members);return snapshot;
  }
  async recoverSnapshot(input:{id:string;archiveId:string}){return this.mutate(async()=>{
    z.object({id:z.string().uuid(),archiveId:z.string().uuid()}).strict().parse(input);await this.assertOwned();const relative=`snapshots/${input.id}`,receipt=path.join(this.directory,relative,"snapshot-receipt.json");let present=true;try{await fs.lstat(receipt);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;present=false;}
    const saved=await this.readArchive(input.archiveId);
    if(present){const snapshot=await this.readSnapshot(input.id);if(snapshot.role!==saved.archive.role||snapshot.manifestSha256!==saved.archive.manifestSha256)throw Error("中断的交接快照与独立封存不一致");return snapshot;}
    const planBytes=await this.ownedBytes(`${relative}/snapshot-plan.json`),plan=z.object({id:z.literal(input.id),role:handoffRole,root:z.string(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),repositoryId:z.string().uuid(),gitlinks:z.record(z.string(),checkpointOid).optional()}).strict().parse(JSON.parse(planBytes.toString("utf8"))),json=await this.ownedBytes(`${relative}/snapshot.json`),snapshot=handoffTreeSnapshot.parse(JSON.parse(json.toString("utf8")));
    if(!path.isAbsolute(plan.root)||plan.role!==saved.archive.role||plan.manifestSha256!==saved.archive.manifestSha256||snapshot.id!==input.id||snapshot.role!==plan.role||snapshot.manifestSha256!==plan.manifestSha256||snapshot.checkpointId!==saved.manifest.id||snapshot.repositoryId!==plan.repositoryId||snapshot.format!==this.marker.format)throw Error("中断的交接快照与独立封存不一致");
    // Reconstruct into a different owned proof; never reuse a partial index or
    // trust the unsealed JSON as evidence for its own contents.
    const proof=await this.snapshotNow({...plan,id:randomUUID(),root:saved.root}),comparable=({id,createdAt,...value}:HandoffTreeSnapshot)=>{void id;void createdAt;return JSON.stringify(value);};
    if(comparable(proof)!==comparable(snapshot))throw Error("中断的交接快照与完整重建结果不一致");
    if(!(await this.ownedBytes(`${relative}/snapshot-plan.json`)).equals(planBytes)||!(await this.ownedBytes(`${relative}/snapshot.json`)).equals(json))throw Error("中断的交接快照在核对期间发生变化");
    this.options.signal?.throwIfAborted();await this.assertOwned();const evidence=await checkpointOutputPath(this.directory,`recoveries/snapshots/${input.id}/${proof.id}.json`);await atomicWrite(evidence,JSON.stringify({version:1,id:input.id,archiveId:input.archiveId,proofSnapshotId:proof.id,sha256:hash(json),at:Date.now()}));await this.pinNow({[`snapshots/${input.id}`]:snapshot.tree});
    let handle:Awaited<ReturnType<typeof fs.open>>|undefined;try{handle=await fs.open(receipt,"wx",0o600);await handle.writeFile(JSON.stringify({id:input.id,tree:snapshot.tree,sha256:hash(json),completedAt:Date.now()}));await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{await handle?.close();}return this.readSnapshot(input.id);
  });}
  private async importHistory(root:string,manifest:CheckpointManifest,repositoryId:string){
    const node=manifest.repos.find(repo=>repo.id===repositoryId);if(!node?.pack||node.format!==this.marker.format)throw Error("交接历史对象缺失或格式不一致");
    const pack=await checkpointSourcePath(root,node.pack.path),before=await checkpointFingerprint(pack,{signal:this.options.signal});if(before.sha256!==node.pack.sha256||before.bytes!==node.pack.bytes)throw Error("交接历史对象完整性未通过");
    if(node.shallow){
      const source=await checkpointSourcePath(root,node.shallow.path),actual=await checkpointFingerprint(source,{signal:this.options.signal});if(actual.sha256!==node.shallow.sha256||actual.bytes!==node.shallow.bytes)throw Error("浅克隆边界与封存不一致");
      const bytes=await fs.readFile(source);if(hash(bytes)!==node.shallow.sha256)throw Error("浅克隆边界在读取时发生变化");const incoming=bytes.toString("utf8").trim().split(/\r?\n/).filter(Boolean),target=path.join(this.directory,".git/shallow"),existing=await fs.readFile(target,"utf8").catch(error=>{if(error.code==="ENOENT")return "";throw error;});
      const boundaries=[...new Set([...incoming,...existing.trim().split(/\r?\n/).filter(Boolean)])];for(const oid of boundaries)if(!checkpointOid.safeParse(oid).success||oid.length!==(node.format==="sha1"?40:64))throw Error("浅克隆边界对象格式无法验证");await this.assertOwned();await atomicWrite(target,boundaries.join("\n")+"\n");
    }
    await this.call(["index-pack","--stdin","--strict","--keep=codex-relay-handoff"],{stdinFile:pack});
    const after=await checkpointFingerprint(pack,{signal:this.options.signal});if(after.sha256!==before.sha256||after.identity!==before.identity)throw Error("交接历史对象在导入时发生变化");
    await this.reconcileShallow();
  }
  private async reconcileShallow(){
    const file=path.join(this.directory,".git/shallow");let before:Awaited<ReturnType<typeof checkpointFingerprint>>;
    try{before=await checkpointFingerprint(file,{signal:this.options.signal});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
    const content=await fs.readFile(file);if(hash(content)!==before.sha256)throw Error("浅克隆边界在核对时发生变化");const boundaries=content.toString("utf8").trim().split(/\r?\n/).filter(Boolean),keep:string[]=[];
    for(const boundary of boundaries){
      checkpointOid.parse(boundary);if(boundary.length!==(this.marker.format==="sha1"?40:64))throw Error("浅克隆边界对象格式不一致");
      const folder=path.dirname(await checkpointOutputPath(this.directory,`shallow-verifications/${randomUUID()}/.placeholder`)),commit=path.join(folder,"commit"),parents:string[]=[];await this.call(["cat-file","commit",boundary],{output:commit});let headerComplete=false;
      for await(const line of handoffRecords(commit,10,this.options.signal)){if(!line){headerComplete=true;break;}if(line.startsWith("parent ")){const parent=checkpointOid.parse(line.slice(7));if(parent.length!==boundary.length)throw Error("浅克隆父提交格式不一致");parents.push(parent);}}
      if(!headerComplete)throw Error("浅克隆边界提交头不完整");if(!parents.length)continue;
      const check=path.join(folder,"parents.txt");await this.call(["cat-file","--batch-check=%(objectname) %(objecttype) %(objectsize)"],{input:parents.join("\n")+"\n",output:check});let count=0,complete=true;
      for await(const row of handoffRecords(check,10,this.options.signal)){const match=/^([a-f0-9]{40,64}) (missing|commit \d+)$/.exec(row);if(!match||match[1]!==parents[count++])throw Error("浅克隆父提交核查记录不一致");if(match[2]==="missing")complete=false;}if(count!==parents.length)throw Error("浅克隆父提交核查不完整");
      // Having just the immediate parent is insufficient: every reachable
      // object must exist, up to other explicitly retained shallow boundaries.
      if(complete){const graph=path.join(folder,"closure.txt");await this.call(["rev-list","--objects","--no-object-names","--missing=print","--stdin"],{input:parents.join("\n")+"\n",output:graph});for await(const row of handoffRecords(graph,10,this.options.signal)){if(row.startsWith("?")){checkpointOid.parse(row.slice(1));complete=false;}else checkpointOid.parse(row);}}
      if(!complete)keep.push(boundary);
    }
    const current=await checkpointFingerprint(file,{signal:this.options.signal});if(current.identity!==before.identity||current.sha256!==before.sha256)throw Error("浅克隆边界在核对时发生变化");await this.assertOwned();
    if(keep.length!==boundaries.length){if(keep.length)await atomicWrite(file,keep.join("\n")+"\n");else await fs.unlink(file);}
  }
  async snapshot(input:SnapshotInput){return this.mutate(()=>this.snapshotNow(input));}
  private async snapshotNow(input:SnapshotInput){
    z.string().uuid().parse(input.id);await this.assertOwned();const manifest=await this.manifest(input.root,input.manifestSha256),node=manifest.repos.find(repo=>repo.id===input.repositoryId);if(!node||node.format!==this.marker.format)throw Error("交接快照仓库缺失或格式不一致");
    const selectionSha256=hash(JSON.stringify({role:input.role,checkpointId:manifest.id,manifestSha256:input.manifestSha256,repositoryId:node.id,gitlinks:Object.entries(input.gitlinks||{}).sort(([a],[b])=>a<b?-1:a>b?1:0)}));
    try{const saved=await this.readSnapshot(input.id);if(saved.selectionSha256!==selectionSha256)throw Error("交接快照请求已用于其他内容");return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    await this.importHistory(input.root,manifest,node.id);
    const snapshotDirectory=await checkpointOutputPath(this.directory,`snapshots/${input.id}/.placeholder`);await fs.mkdir(path.dirname(snapshotDirectory),{recursive:true});const folder=path.dirname(snapshotDirectory),planFile=path.join(folder,"snapshot-plan.json");
    const plan=await fs.open(planFile,"wx",0o600);try{await plan.writeFile(JSON.stringify(input));await plan.sync();}finally{await plan.close();}
    const indexed=await this.indexEntries(node,folder),flagsByPath=new Map(node.flags.map(flag=>[flag.path,flag.bits])),filesByPath=new Map(node.files.map(file=>[file.path,file]));
    const children=manifest.repos.filter(child=>child.id!==node.id&&child.relative.startsWith(node.relative?node.relative+"/":"")&&!manifest.repos.some(middle=>middle.id!==node.id&&middle.id!==child.id&&middle.relative.startsWith(node.relative?node.relative+"/":"")&&child.relative.startsWith(middle.relative+"/")));
    const members:HandoffTreeMember[]=[],payloads:{file:string;oid:string}[]=[],seen=new Set<string>(),excludedIgnored:string[]=[],dependencies:HandoffTreeSnapshot["dependencies"]=[...node.dependencies],nestedRepositories:HandoffTreeSnapshot["nestedRepositories"]=[];let files=0;
    const add=(member:HandoffTreeMember)=>{const name=process.platform==="win32"?member.path.toLowerCase():member.path;if(seen.has(name))throw Error("交接文件路径存在冲突");seen.add(name);members.push(member);};
    for(const file of node.files){
      this.options.signal?.throwIfAborted();if(file.ignored){excludedIgnored.push(file.path);dependencies.push({path:file.path,kind:"ignoredSetup",detail:"已选择的忽略文件保留在完整封存中，需要明确作为工作区配置接入；未自动加入 Git 提案。"});continue;}if(file.kind==="absent"||file.kind==="directory")continue;
      this.options.progress?.({phase:"hashing",role:input.role,path:file.path,bytes:0,files,totalFiles:node.files.length});
      if(file.kind==="file"){
        const physical=await checkpointSourcePath(input.root,file.stored!.path),actual=await checkpointFingerprint(physical,{signal:this.options.signal,gitFormat:this.marker.format,progress:bytes=>this.options.progress?.({phase:"hashing",role:input.role,path:file.path,bytes,files,totalFiles:node.files.length})});
        if(actual.sha256!==file.stored!.sha256||actual.bytes!==file.stored!.bytes)throw Error("交接文件与封存快照不一致");
        const stage=indexed.get(file.path),mode=stage&&["100644","100755","120000"].includes(stage.mode)?stage.mode as "100644"|"100755"|"120000":"100644";
        add({path:file.path,kind:"file",mode,oid:actual.gitOid!,bytes:actual.bytes,sha256:actual.sha256});payloads.push({file:physical,oid:actual.gitOid!});
      }else{
        const link=file.link!,globalName=node.relative?`${node.relative}/${file.path}`:file.path,target=link.internal!==undefined?path.posix.relative(path.posix.dirname(globalName),link.internal||".")||".":path.resolve(node.source,path.dirname(file.path),link.target).split(path.sep).join("/");
        const bytes=Buffer.from(target,"utf8");if(bytes.toString("utf8")!==target)throw Error("交接链接目标无法无损表示");const oid=createHash(this.marker.format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),physical=path.join(folder,`link-${randomUUID()}`);await fs.writeFile(physical,bytes,{flag:"wx",mode:0o600});
        add({path:file.path,kind:"link",mode:"120000",oid,bytes:bytes.length,sha256:hash(bytes),link:{target:link.target,directory:link.directory,internal:link.internal,external:link.external}});payloads.push({file:physical,oid});
      }
      files++;
    }
    const gitlinkPaths=new Set([...indexed.values(),...node.stages.filter(stage=>stage.stage>0)].filter(stage=>stage.mode==="160000").map(stage=>stage.path));
    for(const child of children){const relative=node.relative?child.relative.slice(node.relative.length+1):child.relative;if(gitlinkPaths.has(relative)&&!input.gitlinks?.[relative])throw Error("子仓库尚未准备可验证的交接对象");}
    for(const name of new Set([...gitlinkPaths,...Object.keys(input.gitlinks||{})])){
      checkpointPath.parse(name);const working=filesByPath.get(name);if(working&&(working.kind==="absent"||working.kind==="file"||working.kind==="link"))continue;
      const captured=indexed.get(name),oid=input.gitlinks?.[name]||(captured?.mode==="160000"?captured.oid:undefined);if(!oid)throw Error("子仓库冲突需要明确的交接选择");checkpointOid.parse(oid);if(oid.length!==(this.marker.format==="sha1"?40:64))throw Error("子仓库交接对象格式不一致");add({path:name,kind:"gitlink",mode:"160000",oid,bytes:0});
    }
    // Preserve unmaterialized sparse entries from the index, not as deletions.
    const virtual: HandoffTreeMember[]=[];
    for(const file of node.files.filter(file=>file.kind==="absent")){
      const flags=flagsByPath.get(file.path);if(!flags||(BigInt(`0x${flags}`)&0x40000000n)===0n)continue;const stage=indexed.get(file.path);if(!stage)throw Error("稀疏文件缺少可验证的索引对象");
      if(seen.has(process.platform==="win32"?file.path.toLowerCase():file.path))continue;
      const member:HandoffTreeMember={path:file.path,mode:stage.mode,oid:stage.oid,kind:stage.mode==="160000"?"gitlink":"index",bytes:0};add(member);if(member.kind==="index")virtual.push(member);
    }
    if(virtual.length){
      const inputFile=path.join(folder,"virtual-oids.txt"),outputFile=path.join(folder,"virtual-objects.txt"),inputHandle=await fs.open(inputFile,"wx",0o600);try{for(const member of virtual)await handoffWriteAll(inputHandle,member.oid+"\n");await inputHandle.sync();}finally{await inputHandle.close();}
      await this.call(["cat-file","--batch-check=%(objectname) %(objecttype) %(objectsize)"],{stdinFile:inputFile,output:outputFile});let count=0;
      for await(const record of handoffRecords(outputFile,10,this.options.signal)){const match=/^([a-f0-9]{40,64}) blob (\d+)$/.exec(record),member=virtual[count++];if(!match||!member||member.oid!==match[1]||!Number.isSafeInteger(Number(match[2])))throw Error("稀疏交接对象不完整");member.bytes=Number(match[2]);}if(count!==virtual.length)throw Error("稀疏交接对象数量不完整");
    }
    for(const child of children){const relative=node.relative?child.relative.slice(node.relative.length+1):child.relative;nestedRepositories.push({repositoryId:child.id,relative,tracked:gitlinkPaths.has(relative)});if(!gitlinkPaths.has(relative))dependencies.push({path:relative,kind:"nestedRepository",detail:"独立嵌套仓库需要单独交接，未展平为父仓库文件。"});}
    if(node.shallow)dependencies.push({path:node.shallow.path,kind:"shallowHistory",detail:"保留捕获时的浅克隆历史边界；没有自动获取远程历史。"});
    const fold=(name:string)=>process.platform==="win32"?name.toLowerCase():name;
    for(const member of members){let name=fold(member.path);while(name.includes("/")){name=name.slice(0,name.lastIndexOf("/"));if(seen.has(name))throw Error("交接文件与目录路径存在冲突");}}
    const pathsFile=path.join(folder,"hash-inputs.txt"),hashesFile=path.join(folder,"hash-results.txt"),indexInfo=path.join(folder,"index-info.nul"),index=path.join(folder,"index");
    const pathsHandle=await fs.open(pathsFile,"wx",0o600);try{for(const payload of payloads){this.options.signal?.throwIfAborted();await handoffWriteAll(pathsHandle,JSON.stringify(payload.file.split(path.sep).join("/"))+"\n");}await pathsHandle.sync();}finally{await pathsHandle.close();}
    this.options.progress?.({phase:"snapshotting",role:input.role,bytes:0,files,totalFiles:node.files.length});
    await this.call(["hash-object","--no-filters","-w","--stdin-paths"],{stdinFile:pathsFile,output:hashesFile});let hashed=0;
    for await(const oid of handoffRecords(hashesFile,10,this.options.signal)){if(oid!==payloads[hashed++]?.oid)throw Error("Git 原始对象与完整文件指纹不一致");}if(hashed!==payloads.length)throw Error("Git 原始对象数量不完整");
    const info=await fs.open(indexInfo,"wx",0o600);try{for(const member of members)await handoffWriteAll(info,`${member.mode} ${member.oid}\t${member.path}\0`);await info.sync();}finally{await info.close();}
    const env={GIT_INDEX_FILE:index};await this.call(["read-tree","--empty"],{env});await this.call(["update-index","-z","--index-info"],{env,stdinFile:indexInfo});const tree=await this.text(["write-tree"],{env});
    await this.verifyMembers(tree,members);
    const snapshot=handoffTreeSnapshot.parse({version:1,id:input.id,role:input.role,checkpointId:manifest.id,manifestSha256:input.manifestSha256,selectionSha256,repositoryId:node.id,relative:node.relative,format:this.marker.format,head:node.head,tree,createdAt:Date.now(),members,excludedIgnored,dependencies,nestedRepositories});
    await atomicWrite(path.join(folder,"snapshot.json"),JSON.stringify(snapshot));await this.pinNow({[`snapshots/${input.id}`]:tree});await atomicWrite(path.join(folder,"snapshot-receipt.json"),JSON.stringify({id:input.id,tree,sha256:hash(JSON.stringify(snapshot)),completedAt:Date.now()}));return snapshot;
  }
  async pin(refs:Record<string,string>){return this.mutate(()=>this.pinNow(refs));}
  private async pinNow(refs:Record<string,string>){
    const lines=["start"];for(const [name,oid]of Object.entries(refs)){
      checkpointPath.parse(name);checkpointOid.parse(oid);if(oid.length!==(this.marker.format==="sha1"?40:64))throw Error("交接 Git 对象格式不一致");const ref=`refs/codex-relay/handoff/${this.marker.id}/${name}`;let existing:string|undefined;
      try{existing=await this.text(["rev-parse","--verify","--quiet",ref]);}catch(error){if(!(error instanceof CheckpointGitError)||error.code!==1)throw error;}
      if(existing&&existing!==oid)throw Error("交接固定对象已用于其他内容");lines.push(`${existing?"verify":"create"} ${ref} ${oid}`);
    }lines.push("prepare","commit","");await this.call(["update-ref","--stdin"],{input:lines.join("\n")});
  }
  async readMerge(id:string){
    z.string().uuid().parse(id);await this.assertOwned();const receipt=z.object({id:z.literal(id),sha256:z.string().regex(/^[a-f0-9]{64}$/),at:z.number().finite()}).strict().parse(JSON.parse((await this.ownedBytes(`merges/${id}.receipt.json`)).toString("utf8"))),json=await this.ownedBytes(`merges/${id}.json`);if(hash(json)!==receipt.sha256)throw Error("交接合并记录完整性未通过");const result=handoffMergeResult.parse(JSON.parse(json.toString("utf8")));
    if(result.id!==id||result.format!==this.marker.format||await this.text(["rev-parse","--verify",`refs/codex-relay/handoff/${this.marker.id}/merges/${id}`])!==result.tree)throw Error("交接合并对象固定记录不一致");const evidence=await checkpointSourcePath(this.directory,result.output.path),actual=await checkpointFingerprint(evidence,{signal:this.options.signal});if(actual.sha256!==result.output.sha256||actual.bytes!==result.output.bytes)throw Error("交接合并证据完整性未通过");
    const parsed=await parseHandoffMerge(evidence,result.format,result.status==="clean"?0:1,this.options.signal),after=await checkpointFingerprint(evidence,{signal:this.options.signal});if(actual.identity!==after.identity||actual.sha256!==after.sha256||parsed.tree!==result.tree||JSON.stringify(parsed.conflicts)!==JSON.stringify(result.conflicts)||JSON.stringify(parsed.messages)!==JSON.stringify(result.messages))throw Error("交接合并记录与原始证据不一致");return result;
  }
  async merge(input:MergeInput){return this.mutate(()=>this.mergeNow(input));}
  async recoverMerge(id:string){return this.mutate(async()=>{
    z.string().uuid().parse(id);await this.assertOwned();const receipt=path.join(this.directory,"merges",`${id}.receipt.json`);let present=true;try{await fs.lstat(receipt);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;present=false;}if(present)return this.readMerge(id);
    const planBytes=await this.ownedBytes(`merges/${id}.plan.json`),plan=z.object({version:z.literal(1),id:z.literal(id),format:handoffObjectFormat,baseline:z.object({kind:z.enum(["checkpointWorking","history"]),oid:checkpointOid}).strict(),source:checkpointOid,task:checkpointOid,requestSha256:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.number().finite()}).strict().parse(JSON.parse(planBytes.toString("utf8"))),json=await this.ownedBytes(`merges/${id}.json`),result=handoffMergeResult.parse(JSON.parse(json.toString("utf8")));
    const request={format:plan.format,baseline:plan.baseline,source:plan.source,task:plan.task};if(plan.format!==this.marker.format||plan.requestSha256!==hash(JSON.stringify(request))||result.id!==id||result.format!==plan.format||JSON.stringify(result.baseline)!==JSON.stringify(plan.baseline)||result.source!==plan.source||result.task!==plan.task||result.output.path!==`merges/${id}.nul`)throw Error("中断的交接合并与原始计划不一致");
    const proof=await this.mergeNow({baseline:plan.baseline,source:plan.source,task:plan.task}),comparable=({id,output,...value}:HandoffMergeResult)=>{void id;const {path:unused,...fingerprint}=output;void unused;return JSON.stringify({...value,output:fingerprint});};
    if(comparable(result)!==comparable(proof))throw Error("中断的交接合并与完整重算结果不一致");const actual=await checkpointFingerprint(await checkpointSourcePath(this.directory,result.output.path),{signal:this.options.signal});if(actual.sha256!==proof.output.sha256||actual.bytes!==proof.output.bytes)throw Error("交接合并证据完整性未通过");
    if(!(await this.ownedBytes(`merges/${id}.plan.json`)).equals(planBytes)||!(await this.ownedBytes(`merges/${id}.json`)).equals(json))throw Error("中断的交接合并在核对期间发生变化");
    this.options.signal?.throwIfAborted();await this.assertOwned();const evidence=await checkpointOutputPath(this.directory,`recoveries/merges/${id}/${proof.id}.json`);await atomicWrite(evidence,JSON.stringify({version:1,id,proofMergeId:proof.id,sha256:hash(json),at:Date.now()}));await this.pinNow({[`merges/${id}`]:result.tree});let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{handle=await fs.open(receipt,"wx",0o600);await handle.writeFile(JSON.stringify({id,sha256:hash(json),at:Date.now()}));await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{await handle?.close();}return this.readMerge(id);
  });}
  private async mergeNow(input:MergeInput){
    const id=z.string().uuid().parse(input.id||randomUUID());try{const saved=await this.readMerge(id);if(saved.baseline.kind!==input.baseline.kind||saved.baseline.oid!==input.baseline.oid||saved.source!==input.source||saved.task!==input.task)throw Error("交接合并请求已用于其他内容");return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const request={format:this.marker.format,baseline:input.baseline,source:input.source,task:input.task},planFile=await checkpointOutputPath(this.directory,`merges/${id}.plan.json`),plan=await fs.open(planFile,"wx",0o600);try{await plan.writeFile(JSON.stringify({version:1,id,...request,requestSha256:hash(JSON.stringify(request)),createdAt:Date.now()}));await plan.sync();}finally{await plan.close();}
    this.options.progress?.({phase:"merging",bytes:0,files:0,totalFiles:0});const result=await computeHandoffMerge(this.git,this.directory,this.directory,{format:this.marker.format,...input,id},{signal:this.options.signal,assertOwned:()=>this.assertOwned()});await atomicWrite(path.join(this.directory,`merges/${id}.json`),JSON.stringify(result));await this.pinNow({[`merges/${id}`]:result.tree});await atomicWrite(path.join(this.directory,`merges/${id}.receipt.json`),JSON.stringify({id,sha256:hash(JSON.stringify(result)),at:Date.now()}));return result;
  }
}
