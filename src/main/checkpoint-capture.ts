import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {CheckpointGit,CheckpointGitError} from "./checkpoint-git";
import {checkpointManifest,checkpointPath,type CheckpointManifest,type CheckpointRepo,type CheckpointFile,type CheckpointIndexEntry,type CheckpointStoredFile} from "../shared/checkpoints";
import {checkpointFingerprint,checkpointStat,checkpointOutputPath,insideCheckpoint,sameCheckpointPath} from "./checkpoint-file";
import {copyVerifiedArtifact} from "./vault-file";
import os from "node:os";

export interface CheckpointGuard {path:string;kind:"file"|"absent"|"link"|"directory";identity?:string;sha256?:string;link?:string}
export interface PreparedCheckpoint {manifest:CheckpointManifest;guards:CheckpointGuard[];sourceIdentity:{source:string;head?:string;branch:string;index?:string;config:Record<string,string>}[];listings:{source:string;cached:string[];others:string[];ignored:string[];env:NodeJS.ProcessEnv}[]}
export interface CheckpointCaptureOptions {root:string;signal?:AbortSignal;native?:boolean;ignored?:string[];context?:CheckpointManifest["context"];progress?:(phase:string,file:string,bytes:number)=>void}
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slash=(file:string)=>file.split(path.sep).join("/");
const safeKeys=["core.filemode","core.ignorecase","core.symlinks","core.autocrlf","core.eol","core.sparsecheckout","core.sparsecheckoutcone","index.sparse","core.excludesfile"];
async function optional(git:CheckpointGit,root:string,args:string[]){try{return await git.text(root,args);}catch(error){if(error instanceof CheckpointGitError&&error.code===1)return undefined;throw error;}}
export function parseCheckpointIndex(records:string[]):CheckpointIndexEntry[]{return records.map(row=>{
  const match=/^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(row);if(!match)throw Error("Git 暂存区记录格式无法验证");
  const name=match[4].replace(/\/$/,"");checkpointPath.parse(name);
  return{path:match[4],mode:match[1] as CheckpointIndexEntry["mode"],oid:match[2],stage:Number(match[3])};
});}
async function metadata(git:CheckpointGit,source:string){
  const [head,branch,index]=await Promise.all([optional(git,source,["rev-parse","--verify","--quiet","HEAD"]),optional(git,source,["symbolic-ref","--quiet","HEAD"]),git.text(source,["rev-parse","--path-format=absolute","--git-path","index"])]);
  const config:Record<string,string>={},keys=`^(${safeKeys.map(key=>key.replace(/\./g,"\\.")).join("|")})$`,records=await git.records(source,["config","--null","--get-regexp",keys],undefined,{allowCode:1});for(const record of records){const split=record.indexOf("\n"),key=record.slice(0,split).toLowerCase();if(split<0||!safeKeys.includes(key))throw Error("Git 元数据配置格式无法验证");config[key]=record.slice(split+1);}
  return{source,head,branch:branch||"",index,config};
}
async function sourceAt(root:string,name:string){
  const parts=checkpointPath.parse(name).split("/");let folder=root;
  for(let i=0;i<parts.length;i++){
    const candidate=path.join(folder,parts[i]);let stat;try{stat=await fs.lstat(candidate,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{file:path.join(folder,...parts.slice(i)),absent:true};throw error;}
    if(stat.isSymbolicLink())return{file:candidate,stat,link:true};
    const physical=await fs.realpath(candidate);if(!sameCheckpointPath(candidate,physical)||!insideCheckpoint(root,physical))throw Error("检查点路径超出工作区");
    if(i===parts.length-1)return{file:physical,stat};if(!stat.isDirectory())return{file:candidate,stat};folder=physical;
  }
  throw Error("检查点路径无法验证");
}
async function ignoredPaths(git:CheckpointGit,source:string,names:string[],env:NodeJS.ProcessEnv){return names.length?git.records(source,["check-ignore","--stdin","-z"],env,{input:names.join("\0")+"\0",allowCode:1}):[];}
// Ask Git for directory summaries, then enumerate through our no-follow path
// guard. Git must never walk the contents of a Windows junction for inventory.
async function otherPaths(git:CheckpointGit,source:string,env:NodeJS.ProcessEnv,signal?:AbortSignal){
  const summarized=await git.records(source,["ls-files","--others","--exclude-standard","--directory","--no-empty-directory","-z"],env),result:string[]=[];
  async function visit(name:string){signal?.throwIfAborted();const found=await sourceAt(source,name),relative=slash(path.relative(source,found.file));
    if(found.absent)throw Error("工作区文件范围已变化，请重新预览");if(found.link||!found.stat!.isDirectory()){result.push(relative);return;}
    try{await fs.lstat(path.join(found.file,".git"));result.push(relative);return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const children=(await fs.readdir(found.file)).filter(part=>part.toLowerCase()!==".git").map(part=>`${relative}/${part}`),ignored=new Set(await ignoredPaths(git,source,children,env));
    for(const child of children.sort())if(!ignored.has(child))await visit(child);
  }
  for(const record of summarized){const name=record.replace(/\/$/,"");if(record.endsWith("/"))await visit(name);else result.push(name);}return result.sort();
}
export async function prepareCheckpoint(cwd:string,title:string,options:CheckpointCaptureOptions):Promise<PreparedCheckpoint>{
  const git=new CheckpointGit(path.join(options.root,"commands"),options),project=await fs.realpath(cwd),root=await fs.realpath(await git.text(project,["rev-parse","--show-toplevel"]));
  if(!sameCheckpointPath(project,root)&&!insideCheckpoint(root,project))throw Error("项目不属于当前 Git 工作区");
  if(sameCheckpointPath(root,options.root)||insideCheckpoint(root,path.resolve(options.root)))throw Error("检查点存储必须位于源工作区之外");
  const manifest:CheckpointManifest={version:1,id:randomUUID(),title,createdAt:Date.now(),source:root,projectRelative:slash(path.relative(root,project)),ignored:(options.ignored||[]).map(v=>checkpointPath.parse(v)),repos:[],context:options.context,fileCount:0,totalBytes:0,signature:"0".repeat(64)};
  const result:PreparedCheckpoint={manifest,guards:[],sourceIdentity:[],listings:[]},visited=new Set<string>();
  // Selected ignored files belong to their deepest Git repository. Asking a
  // superproject to check-ignore a path inside a submodule is an error in Git.
  const ignoredRoutes:{owner:string;local:string}[]=[],selectedRepositories=new Set<string>();
  for(const name of manifest.ignored){options.signal?.throwIfAborted();const found=await sourceAt(root,name);if(found.absent||!sameCheckpointPath(found.file,path.join(root,name))||!found.link&&!found.stat?.isFile())throw Error("忽略文件选择已变化，请重新预览");
    const owner=await fs.realpath(await git.text(path.dirname(found.file),["rev-parse","--show-toplevel"]));if(!sameCheckpointPath(root,owner)&&!insideCheckpoint(root,owner))throw Error("忽略文件选择已变化，请重新预览");ignoredRoutes.push({owner,local:slash(path.relative(owner,found.file))});
    let folder=owner;while(!sameCheckpointPath(folder,root)){try{await fs.lstat(path.join(folder,".git"));selectedRepositories.add(folder);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const next=path.dirname(folder);if(next===folder||!sameCheckpointPath(root,next)&&!insideCheckpoint(root,next))throw Error("忽略文件选择已变化，请重新预览");folder=next;}
  }
  async function storeMetadata(sourceFile:string,stored:string):Promise<CheckpointStoredFile|undefined>{
    try{await fs.lstat(sourceFile);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){result.guards.push({path:sourceFile,kind:"absent"});return;}throw error;}
    const file=await fs.realpath(sourceFile);if(!sameCheckpointPath(file,sourceFile)||(await fs.lstat(sourceFile)).isSymbolicLink())throw Error("Git 元数据路径已变化");
    const output=await checkpointOutputPath(options.root,stored),actual=await checkpointFingerprint(file,{signal:options.signal,output});
    result.guards.push({path:file,kind:"file",identity:actual.identity,sha256:actual.sha256});return{path:stored,bytes:actual.bytes,sha256:actual.sha256};
  }
  async function inspect(source:string,relative:string){
    options.signal?.throwIfAborted();const canonical=await fs.realpath(source);const key=process.platform==="win32"?canonical.toLowerCase():canonical;if(visited.has(key))throw Error("子模块形成重复或循环工作区，未创建检查点");visited.add(key);
    const before=await metadata(git,canonical);result.sourceIdentity.push(before);
    const gitDir=await fs.realpath(await git.text(canonical,["rev-parse","--absolute-git-dir"])),commonDir=await fs.realpath(await git.text(canonical,["rev-parse","--path-format=absolute","--git-common-dir"]));
    const common=await fs.stat(commonDir,{bigint:true}),format=await git.text(canonical,["rev-parse","--show-object-format"]);if(!["sha1","sha256"].includes(format))throw Error("Git 对象格式不受支持");
    for(const folder of new Set([canonical,gitDir,commonDir])){const stat=await fs.stat(folder,{bigint:true});result.guards.push({path:folder,kind:"directory",identity:[stat.dev,stat.ino].map(String).join(":")});}
    const node:CheckpointRepo={id:randomUUID(),relative,source:canonical,gitDir,commonDir,identity:[common.dev,common.ino].map(String).join(":"),format:format as "sha1"|"sha256",head:before.head,branch:before.branch,config:before.config,stages:[],undo:[],flags:[],roots:[],files:[],dependencies:[]};
    manifest.repos.push(node);const prefix=`repos/${node.id}`;
    // A split index refers to its shared base beside the index file. Preserve it
    // before asking Git to read the owned index copy, never rewrite the source.
    let shared=await optional(git,canonical,["rev-parse","--shared-index-path"]);
    if(shared){shared=path.resolve(canonical,shared);node.sharedName=path.basename(shared);node.sharedIndex=await storeMetadata(shared,`${prefix}/${node.sharedName}`);}
    node.index=await storeMetadata(before.index!,`${prefix}/index`);
    const shallow=await git.text(canonical,["rev-parse","--path-format=absolute","--git-path","shallow"]);node.shallow=await storeMetadata(shallow,`${prefix}/shallow`);
    const sparse=await git.text(canonical,["rev-parse","--path-format=absolute","--git-path","info/sparse-checkout"]);node.sparse=await storeMetadata(sparse,`${prefix}/sparse-checkout`);
    // Git versions may look for a split base in GIT_DIR and freshen its mtime.
    // Read all index/working inventory through an owned metadata repository.
    const inspection=path.join(options.root,"inspection",node.id);await fs.mkdir(path.dirname(inspection),{recursive:true});await git.run(options.root,["init",`--object-format=${node.format}`,path.relative(options.root,inspection)]);
    const inspectionDir=path.join(inspection,".git");
    if(node.sparse)await fs.copyFile(path.join(options.root,node.sparse.path),path.join(inspectionDir,"info/sparse-checkout"));
    if(node.sharedIndex)await fs.copyFile(path.join(options.root,node.sharedIndex.path),path.join(inspectionDir,node.sharedName!));
    for(const [key,value] of Object.entries(node.config))if(key!=="core.excludesfile")await git.run(inspection,["config",key,value]);
    const exclude=await git.text(canonical,["rev-parse","--path-format=absolute","--git-path","info/exclude"]);node.exclude=await storeMetadata(exclude,`${prefix}/exclude`);
    if(node.exclude)await fs.copyFile(path.join(options.root,node.exclude.path),path.join(inspectionDir,"info/exclude"));
    const configuredExclude=await optional(git,canonical,["config","--path","--get","core.excludesfile"]),globalExclude=configuredExclude?path.resolve(canonical,configuredExclude):path.join(process.env.XDG_CONFIG_HOME||path.join(process.env.HOME||os.homedir(),".config"),"git/ignore");
    node.globalExclude=await storeMetadata(globalExclude,`${prefix}/global-exclude`);
    const emptyExclude=path.join(inspectionDir,"empty-exclude");await fs.writeFile(emptyExclude,"");
    await git.run(inspection,["config","core.excludesfile",node.globalExclude?path.join(options.root,node.globalExclude.path):emptyExclude]);
    const env:NodeJS.ProcessEnv={GIT_DIR:inspectionDir,GIT_WORK_TREE:canonical,GIT_OBJECT_DIRECTORY:path.join(commonDir,"objects"),GIT_INDEX_FILE:node.index?path.join(options.root,node.index.path):path.join(inspectionDir,"index")};
    node.stages=parseCheckpointIndex(await git.records(canonical,["ls-files","--stage","--sparse","-z"],env));
    node.undo=parseCheckpointIndex(await git.records(canonical,["ls-files","--resolve-undo","-z"],env));
    node.flags=await git.indexFlags(canonical,env);
    const cached=await git.records(canonical,["ls-files","--cached","-z"],env),others=await otherPaths(git,canonical,env,options.signal);
    const ignored=ignoredRoutes.filter(route=>sameCheckpointPath(route.owner,canonical)).map(route=>route.local);result.listings.push({source:canonical,cached,others,ignored,env});
    if(ignored.length){const actualIgnored=new Set(await ignoredPaths(git,canonical,ignored,env));for(const name of ignored)if(!actualIgnored.has(name)||(await sourceAt(canonical,name)).absent)throw Error("忽略文件选择已变化，请重新预览");}
    const base=node.head?await git.records(canonical,["ls-tree","-r","--name-only","-z",node.head]):[];
    const submodules=new Set(node.stages.filter(e=>e.mode==="160000").map(e=>e.path));
    const cachedNames=new Set(cached),baseNames=new Set(base),ignoredNames=new Set(ignored),names=[...new Set([...base,...cached,...others,...ignored])];
    for(const selected of selectedRepositories)if(insideCheckpoint(canonical,selected)&&![...selectedRepositories].some(middle=>insideCheckpoint(canonical,middle)&&insideCheckpoint(middle,selected))){const local=slash(path.relative(canonical,selected));if(!names.some(name=>name===local||local.startsWith(name.replace(/\/$/,"")+"/")))names.push(local);}names.sort();const physicalNames=new Set<string>();
    for(const name of names){options.signal?.throwIfAborted();options.progress?.("inspecting",relative?`${relative}/${name}`:name,0);const found=await sourceAt(canonical,name),actualName=slash(path.relative(canonical,found.file));checkpointPath.parse(actualName);
      const physicalKey=process.platform==="win32"?actualName.toLowerCase():actualName;if(physicalNames.has(physicalKey))continue;physicalNames.add(physicalKey);
      const tracked=cachedNames.has(name)||baseNames.has(name),file:CheckpointFile={path:actualName,kind:"absent",tracked,ignored:ignoredNames.has(name)};
      if(found.absent){result.guards.push({path:found.file,kind:"absent"});node.files.push(file);continue;}
      const stat=found.stat!;
      if(found.link){const target=await fs.readlink(found.file);let directory=false;try{directory=(await fs.stat(found.file)).isDirectory();}catch{}
        const normalizedTarget=path.resolve(path.dirname(found.file),target),internal=sameCheckpointPath(normalizedTarget,root)?"":insideCheckpoint(root,normalizedTarget)?slash(path.relative(root,normalizedTarget)):undefined;
        file.kind="link";file.link={target,directory,internal,external:internal===undefined};
        if(file.link.external)node.dependencies.push({path:file.path,kind:"externalLink",detail:target});
        result.guards.push({path:found.file,kind:"link",identity:checkpointStat(stat),link:target});node.files.push(file);continue;
      }
      if(stat.isDirectory()){
        result.guards.push({path:found.file,kind:"directory",identity:[stat.dev,stat.ino].map(String).join(":")});
        let moduleRoot:string|undefined;try{moduleRoot=await fs.realpath(await git.text(found.file,["rev-parse","--show-toplevel"]));}catch{}
        if(moduleRoot&&sameCheckpointPath(moduleRoot,found.file)){await inspect(found.file,relative?`${relative}/${actualName}`:actualName);continue;}
        if(submodules.has(name)){
          if((await fs.readdir(found.file)).length)throw Error("未初始化子模块中存在本地文件，请先将其接入 Git 后再保存检查点");
          node.dependencies.push({path:actualName,kind:"uninitializedSubmodule",detail:node.stages.find(e=>e.path===name&&e.mode==="160000")!.oid});
        }
        file.kind="directory";node.files.push(file);continue;
      }
      if(!stat.isFile())throw Error("检查点包含无法封存的特殊文件");
      const fingerprint=await checkpointFingerprint(found.file,{signal:options.signal,progress:bytes=>options.progress?.("inspecting",actualName,bytes)});
      file.kind="file";file.mode=Number(stat.mode&0o777n);file.stored={path:`files/${node.id}/${randomUUID()}`,bytes:fingerprint.bytes,sha256:fingerprint.sha256};node.files.push(file);
      result.guards.push({path:found.file,kind:"file",identity:fingerprint.identity,sha256:fingerprint.sha256});manifest.fileCount++;manifest.totalBytes+=fingerprint.bytes;
      if(!Number.isSafeInteger(manifest.totalBytes))throw Error("检查点字节总量无法精确表示");
    }
    const roots=[...(node.head?[node.head]:[]),...node.stages.filter(e=>e.mode!=="160000").map(e=>e.oid),...node.undo.filter(e=>e.mode!=="160000").map(e=>e.oid)];node.roots=[...new Set(roots)];
    const filters=await optional(git,canonical,["config","--get-regexp","^filter\\..*\\.(clean|smudge|process|required)$"]);if(filters)node.dependencies.push({path:node.files.find(f=>f.path===".gitattributes")?.path||".gitattributes",kind:"externalFilter",detail:"Git 过滤器配置未被执行或复制；原始文件字节独立保存。"});
  }
  await inspect(root,"");
  const captured=manifest.repos.flatMap(repo=>repo.files.filter(file=>file.kind!=="absent").map(file=>repo.relative?`${repo.relative}/${file.path}`:file.path));
  for(const repo of manifest.repos)for(const file of repo.files)if(file.kind==="link"&&file.link!.internal!==undefined){const target=file.link!.internal!;if(target&&!captured.some(name=>sameCheckpointPath(path.join(root,name),path.join(root,target))||name.startsWith(target+"/")))repo.dependencies.push({path:file.path,kind:"excludedLinkTarget",detail:`${target} — 链接目标未包含在当前文件选择中。`});}
  if(manifest.projectRelative&&!manifest.repos[0].files.some(file=>file.path===manifest.projectRelative)){
    const stat=await fs.stat(project,{bigint:true});manifest.repos[0].files.push({path:manifest.projectRelative,kind:"directory",tracked:false,ignored:false});result.guards.push({path:project,kind:"directory",identity:[stat.dev,stat.ino].map(String).join(":")});
  }
  manifest.signature=digest({repos:manifest.repos,guards:result.guards,sourceIdentity:result.sourceIdentity,listings:result.listings,ignored:manifest.ignored});checkpointManifest.parse(manifest);
  await assertCheckpointSource(result,options);return result;
}
export async function assertCheckpointSource(prepared:PreparedCheckpoint,options:CheckpointCaptureOptions,full=false){
  const git=new CheckpointGit(path.join(options.root,"commands"),options);
  for(const before of prepared.sourceIdentity){if(JSON.stringify(await metadata(git,before.source))!==JSON.stringify(before))throw Error("工作区、分支或 Git 配置已变化，请重新预览");}
  for(const listing of prepared.listings){
    const env=listing.env;
    const cached=await git.records(listing.source,["ls-files","--cached","-z"],env),others=await otherPaths(git,listing.source,env,options.signal);
    if(JSON.stringify(cached)!==JSON.stringify(listing.cached)||JSON.stringify(others)!==JSON.stringify(listing.others))throw Error("工作区文件范围已变化，请重新预览");
  }
  for(const guard of prepared.guards){options.signal?.throwIfAborted();let stat;try{stat=await fs.lstat(guard.path,{bigint:true});}catch(error){if(guard.kind==="absent"&&(error as NodeJS.ErrnoException).code==="ENOENT")continue;throw Error("检查点源文件已变化");}
    if(guard.kind==="absent")throw Error("检查点源文件已变化");
    if(guard.kind==="directory"){if(!stat.isDirectory()||stat.isSymbolicLink()||[stat.dev,stat.ino].map(String).join(":")!==guard.identity)throw Error("检查点源目录已变化");continue;}
    if(checkpointStat(stat)!==guard.identity)throw Error(`检查点源文件已变化：${guard.path}`);
    if(guard.kind==="link"){if(!stat.isSymbolicLink()||await fs.readlink(guard.path)!==guard.link)throw Error("检查点源链接已变化");}
    else if(full&&(await checkpointFingerprint(guard.path,{signal:options.signal})).sha256!==guard.sha256)throw Error("检查点源内容已变化");
  }
}
export async function captureCheckpointFiles(prepared:PreparedCheckpoint,options:CheckpointCaptureOptions){
  await assertCheckpointSource(prepared,options);
  const git=new CheckpointGit(path.join(options.root,"commands"),options);
  for(const repo of prepared.manifest.repos){
    for(const file of repo.files){if(file.kind!=="file")continue;options.signal?.throwIfAborted();
      await copyVerifiedArtifact({cwd:repo.source,relative:file.path,stagingRoot:options.root,output:file.stored!.path,bytes:file.stored!.bytes,sha256:file.stored!.sha256,signal:options.signal,
        progress:value=>options.progress?.(value.phase,file.path,value.bytes)});
    }
    const packed=`repos/${repo.id}/objects.pack`,output=await checkpointOutputPath(options.root,packed);options.progress?.("packing",repo.relative,0);
    await git.run(repo.source,["pack-objects","--stdout","--revs","--threads=2"],{input:repo.roots.join("\n")+(repo.roots.length?"\n":""),output});
    const actual=await checkpointFingerprint(output,{signal:options.signal});repo.pack={path:packed,bytes:actual.bytes,sha256:actual.sha256};
  }
  await assertCheckpointSource(prepared,options,true);prepared.manifest.sealedAt=Date.now();return checkpointManifest.parse(prepared.manifest);
}
