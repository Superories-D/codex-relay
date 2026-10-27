import {promises as fs,constants,type Stats} from "node:fs";
import path from "node:path";
import {TextDecoder} from "node:util";
import {CheckpointGit,CheckpointGitError} from "../main/checkpoint-git";
import {parseGitStatus,gitStaged,gitUnstaged,type GitChange} from "../shared/git";
import {resolveWorkspace} from "./workspaces";

const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return !relative||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);};
const stamp=(stat:Stats)=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");
const textLimit=2*1024*1024;
const isolated:NodeJS.ProcessEnv={GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_NO_REPLACE_OBJECTS:"1"};
const safeConfig=["core.filemode","core.ignorecase","core.symlinks","core.autocrlf","core.eol","core.sparsecheckout","core.sparsecheckoutcone","index.sparse"];
function projectPath(value:string) {
  if(!value||value.length>32767||/[\x00-\x1f\x7f]/.test(value)||value.split("/").some(part=>!part||part==="."||part===".."||part.toLowerCase()===".git"))throw Error("Invalid relative project path");
  return value;
}
async function optional(git:CheckpointGit,cwd:string,args:string[]) {try{return await git.text(cwd,args);}catch(error){if(error instanceof CheckpointGitError&&error.code===1)return "";throw error;}}
type ProjectChange=GitChange&{directory?:boolean};
export type ProjectChanges={root:string;branch:string;head:string;at:number;files:ProjectChange[];total:number;truncated:boolean};

/** Read a bounded, stable file through its opened identity, before any copy. */
async function readFile(file:string,allowed:(actual:string)=>boolean,max:number):Promise<{bytes:Buffer;mode:number;mtime:number}|undefined> {
  let handle;
  try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  try {
    const before=await handle.stat(),actual=await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if(!allowed(actual)||!before.isFile()||before.nlink!==1)throw Error("项目文件不是可读取的独立普通文件");
    if(before.size>max)throw Error("项目检查文件超过预览上限");
    const bytes=Buffer.alloc(before.size);let position=0;
    while(position<bytes.length){const read=await handle.read(bytes,position,bytes.length-position,position);if(!read.bytesRead)break;position+=read.bytesRead;}
    if(position!==bytes.length||stamp(await handle.stat())!==stamp(before))throw Error("文件在读取期间变化，请刷新项目后重试");
    return {bytes,mode:before.mode&0o777,mtime:Math.floor(before.mtimeMs/1000)};
  }finally{await handle.close();}
}

export class ProjectGit {
  constructor(private dataRoot:string,private roots:string[]) {}
  private async inspect<T>(cwd:string,action:(context:{git:CheckpointGit;root:string;branch:string;head:string;env:NodeJS.ProcessEnv;scratch:string;files:ProjectChange[]})=>Promise<T>) {
    const requested=await resolveWorkspace(this.roots,cwd);
    if(!(await fs.stat(requested)).isDirectory())throw Error("Project must be a directory");
    const parent=path.join(this.dataRoot,"project-inspections");await fs.mkdir(parent,{recursive:true,mode:0o700});
    const scratch=await fs.mkdtemp(path.join(parent,"read-"));
    try {
      const git=new CheckpointGit(path.join(scratch,"commands"),{native:false,signal:AbortSignal.timeout(15000)});
      const root=await resolveWorkspace(this.roots,await git.text(requested,["rev-parse","--show-toplevel"]));
      const identity=await fs.stat(root,{bigint:true});
      const [gitDir,commonDir,format,branch,head]=await Promise.all([
        git.text(root,["rev-parse","--absolute-git-dir"]).then(file=>fs.realpath(file)),
        git.text(root,["rev-parse","--path-format=absolute","--git-common-dir"]).then(file=>fs.realpath(file)),
        git.text(root,["rev-parse","--show-object-format"]),optional(git,root,["symbolic-ref","--quiet","HEAD"]),optional(git,root,["rev-parse","--verify","--quiet","HEAD"]),
      ]);
      if(!["sha1","sha256"].includes(format)||[gitDir,commonDir].some(folder=>inside(this.dataRoot,folder)||inside(folder,this.dataRoot)))throw Error("Git 元数据范围不可用于项目检查");
      const metadata=(actual:string)=>[gitDir,commonDir].some(folder=>inside(folder,actual))&&!inside(this.dataRoot,actual);
      const owned=path.join(scratch,"repository");await git.run(scratch,["-c","init.templateDir=","init",`--object-format=${format}`,owned],{env:isolated});
      const directory=path.join(owned,".git");
      const copy=async(source:string,target:string,limit=16*1024*1024)=>{
        const content=await readFile(source,metadata,limit);
        if(content){
          await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,content.bytes,{flag:"wx",mode:0o600});
          // A fresh index-copy timestamp can incorrectly validate stale stat
          // entries. Keep a conservative source time so racy files are hashed.
          await fs.utimes(target,content.mtime,content.mtime);
        }
        return !!content;
      };
      const shared=await optional(git,root,["rev-parse","--shared-index-path"]);
      if(shared)await copy(path.resolve(root,shared),path.join(directory,path.basename(shared)));
      const index=await git.text(root,["rev-parse","--path-format=absolute","--git-path","index"]);await copy(index,path.join(directory,"index"));
      for(const name of ["shallow","info/sparse-checkout"]){const source=await git.text(root,["rev-parse","--path-format=absolute","--git-path",name]);await copy(source,path.join(directory,name));}
      for(const key of safeConfig){const value=await optional(git,root,["config","--get",key]);if(value)await git.run(owned,["config",key,value],{env:isolated});}
      const objects=await fs.realpath(path.join(commonDir,"objects"));if(!metadata(objects))throw Error("Git 对象目录超出元数据范围");
      const env={...isolated,GIT_DIR:directory,GIT_WORK_TREE:root,GIT_OBJECT_DIRECTORY:objects,GIT_INDEX_FILE:path.join(directory,"index")};
      if(head)await git.run(owned,["update-ref","HEAD",head],{env});
      // No source config, filters, hooks or recursive submodule processes run.
      // Original Git supplies only the ignored/untracked name inventory.
      const raw=await git.run(root,["status","--porcelain=v1","-z","--untracked-files=no","--ignore-submodules=all"],{env,metadataLimit:4*1024*1024});
      const others=await git.run(root,["ls-files","--others","--exclude-standard","-z"],{metadataLimit:4*1024*1024});
      const decoder=new TextDecoder("utf-8",{fatal:true});
      const files:ProjectChange[]=[...parseGitStatus(decoder.decode(raw)),...decoder.decode(others).split("\0").filter(Boolean).map(name=>({path:name.replace(/\/$/,""),index:"?",worktree:"?",...(name.endsWith("/")?{directory:true}:{})}))];
      for(const file of files){projectPath(file.path);if(file.original)projectPath(file.original);}
      const result=await action({git,root,branch:branch.replace(/^refs\/heads\//,"")||"detached HEAD",head,env,scratch,files});
      const current=await resolveWorkspace(this.roots,root),after=await fs.stat(current,{bigint:true});
      if(current!==root||after.dev!==identity.dev||after.ino!==identity.ino)throw Error("项目目录在读取期间变化，请刷新后重试");
      return result;
    }finally{await fs.rm(scratch,{recursive:true,force:true});}
  }
  changes(cwd:string):Promise<ProjectChanges> {
    return this.inspect(cwd,async context=>({root:context.root,branch:context.branch,head:context.head,at:Date.now(),files:context.files.slice(0,500),total:context.files.length,truncated:context.files.length>500}));
  }
  async diff(cwd:string,relative:string,staged=false) {
    projectPath(relative);
    return this.inspect(cwd,async({git,root,branch,head,env,scratch,files})=>{
      const file=files.find(file=>file.path===relative&&(staged?gitStaged(file):gitUnstaged(file)));
      if(!file)throw Error("所选文件已不在该类变更中，请刷新项目");
      if(file.directory)throw Error("嵌套仓库目录只展示名称，请将该仓库单独配置为允许的项目");
      let text:string,preview:"text"|"binary"|"encoded"="text";
      if(!staged&&file.index==="?"&&file.worktree==="?") {
        const content=await readFile(path.join(root,...relative.split("/")),actual=>inside(root,actual),textLimit);
        if(!content)throw Error("文件已移除，请刷新项目");
        if(content.bytes.includes(0)){preview="binary";text="Binary file (preview omitted)";}
        else try{text=new TextDecoder("utf-8",{fatal:true}).decode(content.bytes).split("\n").map(line=>"+"+line).join("\n");}
        catch{preview="encoded";text="Non-UTF-8 file (preview omitted)";}
      }else {
        const tree=path.join(scratch,"tree");await fs.mkdir(tree,{mode:0o700});
        if(!staged){
          const content=await readFile(path.join(root,...relative.split("/")),actual=>inside(root,actual),textLimit);
          if(content){const target=path.join(tree,...relative.split("/"));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,content.bytes,{flag:"wx",mode:content.mode});await fs.chmod(target,content.mode);}
        }
        const output=await git.run(root,["--literal-pathspecs","diff","--no-ext-diff","--no-textconv","--no-color","--no-relative","--ignore-submodules=all",...(staged?["--cached"]:[]),"--",relative,...(staged&&file.original?[file.original]:[])],{env:{...env,GIT_WORK_TREE:tree},metadataLimit:textLimit});
        try{text=new TextDecoder("utf-8",{fatal:true}).decode(output);}
        catch{preview="encoded";text="Non-UTF-8 diff (preview omitted)";}
      }
      return {root,branch,head,path:relative,staged,at:Date.now(),text,preview,rawComparison:true};
    });
  }
}
