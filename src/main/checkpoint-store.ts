import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {checkpointEntry,checkpointRestore,type CheckpointEntry} from "../shared/checkpoints";
import {insideCheckpoint,sameCheckpointPath} from "./checkpoint-file";

const catalog=z.object({version:z.literal(1),owner:z.string().uuid(),revision:z.number().int().nonnegative(),storage:z.string(),roots:z.array(z.string()),entries:z.array(checkpointEntry),restores:z.array(checkpointRestore)}).strict();
type Catalog=z.infer<typeof catalog>;
const marker=z.object({version:z.literal(1),owner:z.string().uuid(),id:z.string().uuid().optional()}).strict();
export class CheckpointStore {
  private state?:Catalog;private loading?:Promise<Catalog>;private chain:Promise<unknown>=Promise.resolve();issue?:string;
  constructor(private options:{root:string;write?:typeof atomicWrite;protect?:(root:string)=>Promise<void>}){}
  private get file(){return path.join(this.options.root,"workspace-checkpoints.json");}
  private queue<T>(action:()=>Promise<T>){const value=this.chain.then(action);this.chain=value.catch(()=>{});return value;}
  private async commit(next:Catalog){catalog.parse(next);try{await(this.options.write??atomicWrite)(this.file,JSON.stringify(next));}catch(error){this.issue="检查点记录无法保存，请检查磁盘后重启。";throw Error(this.issue,{cause:error});}this.state=next;}
  private async read(){let state:Catalog;
    try{state=catalog.parse(JSON.parse(await fs.readFile(this.file,"utf8")));if(!path.isAbsolute(state.storage)||state.roots.some(root=>!path.isAbsolute(root))||new Set(state.entries.map(e=>e.id)).size!==state.entries.length||new Set(state.restores.map(r=>r.id)).size!==state.restores.length||state.entries.some(e=>!state.roots.includes(e.root)))throw Error("Invalid checkpoint catalog");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw Error("检查点记录无法读取，原记录未被覆盖。");state={version:1,owner:randomUUID(),revision:0,storage:path.join(this.options.root,"workspace-checkpoints"),roots:[],entries:[],restores:[]};await this.commit(state);return state;}
    const next=structuredClone(state);let changed=false;
    for(const entry of next.entries)if(entry.status==="capturing"||entry.status==="preview"){entry.status="interrupted";entry.issue="上次操作被中断；完整封存可重新复核，预览需要重新创建。";changed=true;}
    for(const restore of next.restores)if(restore.status==="restoring"){restore.status="interrupted";restore.issue="恢复被中断，请核对原目标；已有分支与文件会保留。";changed=true;}
    this.state=state;if(changed){next.revision++;await this.commit(next);}return this.state!;
  }
  private load(){if(this.state)return Promise.resolve(this.state);return this.loading??=this.read();}
  async list(){await this.chain;return {...structuredClone(await this.load()),issue:this.issue};}
  mutate(action:(next:Catalog)=>void){return this.queue(async()=>{if(this.issue)throw Error(this.issue);const next=structuredClone(await this.load());action(next);next.revision++;await this.commit(next);return structuredClone(next);});}
  patch(id:string,patch:Partial<CheckpointEntry>){return this.mutate(next=>{const entry=next.entries.find(e=>e.id===id);if(!entry)throw Error("检查点不存在");Object.assign(entry,patch);});}
  private async claim(directory:string,owner:string){
    await fs.mkdir(directory,{recursive:true,mode:0o700});const physical=await fs.realpath(directory);if(!sameCheckpointPath(directory,physical)||(await fs.lstat(directory)).isSymbolicLink()||physical===path.parse(physical).root)throw Error("检查点存储目录已变化");
    const file=path.join(physical,".relay-checkpoints.json");try{const value=marker.parse(JSON.parse(await fs.readFile(file,"utf8")));if(value.owner!==owner||value.id)throw Error("检查点存储属于其他配置");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"||(await fs.readdir(physical)).length)throw error;await this.options.protect?.(physical);const handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(JSON.stringify({version:1,owner}));await handle.sync();}finally{await handle.close();}}
    for(const name of ["staging","versions","restores"]){const folder=path.join(physical,name);await fs.mkdir(folder,{recursive:true,mode:0o700});await this.regular(folder,physical);}return physical;
  }
  private async regular(directory:string,parent:string){const physical=await fs.realpath(directory);if(!insideCheckpoint(parent,physical)||!sameCheckpointPath(directory,physical)||(await fs.lstat(directory)).isSymbolicLink()||!(await fs.stat(directory)).isDirectory())throw Error("检查点目录结构已变化");return physical;}
  currentStorage(){return this.queue(async()=>{const state=await this.load(),storage=await this.claim(state.storage,state.owner);if(!state.roots.includes(storage)){const next=structuredClone(state);next.storage=storage;next.roots.push(storage);next.revision++;await this.commit(next);}return storage;});}
  setStorage(parent:string){return this.queue(async()=>{if(!path.isAbsolute(parent))throw Error("请选择绝对路径");const state=await this.load(),storage=await this.claim(path.join(parent,"Codex Relay Checkpoints"),state.owner),next=structuredClone(state);next.storage=storage;if(!next.roots.includes(storage))next.roots.push(storage);next.revision++;await this.commit(next);});}
  async ownedRoot(root:string){const state=await this.load();if(!state.roots.includes(root)||!sameCheckpointPath(root,await fs.realpath(root))||(await fs.lstat(root)).isSymbolicLink())throw Error("检查点存储目录已变化");const value=marker.parse(JSON.parse(await fs.readFile(path.join(root,".relay-checkpoints.json"),"utf8")));if(value.owner!==state.owner||value.id)throw Error("检查点存储属于其他配置");return state.owner;}
  async create(root:string,part:"staging"|"restores",id:string){z.string().uuid().parse(id);const owner=await this.ownedRoot(root),parent=path.join(root,part);await this.regular(parent,root);const folder=path.join(parent,id);await fs.mkdir(folder,{mode:0o700});await this.regular(folder,parent);await atomicWrite(path.join(folder,".relay-checkpoint.json"),JSON.stringify({version:1,owner,id}));return folder;}
  async directory(root:string,part:"staging"|"versions"|"restores",id:string){z.string().uuid().parse(id);const owner=await this.ownedRoot(root),parent=path.join(root,part);await this.regular(parent,root);const folder=await this.regular(path.join(parent,id),parent),value=marker.parse(JSON.parse(await fs.readFile(path.join(folder,".relay-checkpoint.json"),"utf8")));if(value.owner!==owner||value.id!==id)throw Error("检查点目录不属于当前配置");return folder;}
  async publish(entry:CheckpointEntry){const source=await this.directory(entry.root,"staging",entry.id),parent=path.join(entry.root,"versions");await this.regular(parent,entry.root);const target=path.join(parent,entry.id);try{await fs.lstat(target);throw Error("检查点目标已存在");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}await fs.rename(source,target);return target;}
  async pruneCaptureScratch(entry:CheckpointEntry){const stage=await this.directory(entry.root,"staging",entry.id);for(const name of ["commands","inspection","seal-audit"]){const directory=path.join(stage,name);let actual:string;try{actual=await this.regular(directory,stage);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}if(path.dirname(actual)!==stage||!path.isAbsolute(actual)||!insideCheckpoint(stage,actual))throw Error("检查点临时目录归属已变化");await fs.rm(actual,{recursive:true,force:true});}}
  async drain(){await this.chain;}
}
