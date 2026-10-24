import {promises as fs,constants,type BigIntStats} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {checkpointPath,type CheckpointStoredFile} from "../shared/checkpoints";
export const insideCheckpoint=(root:string,file:string)=>{const rel=path.relative(root,file);return !!rel&&rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);};
const identity=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export const sameCheckpointPath=(a:string,b:string)=>process.platform==="win32"?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
export const checkpointStat=(value:BigIntStats)=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].map(String).join(":");
export async function checkpointFingerprint(file:string,options:{signal?:AbortSignal;output?:string;progress?:(bytes:number)=>void}={}){
  options.signal?.throwIfAborted();const physical=await fs.realpath(file),before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||!sameCheckpointPath(physical,file))throw Error("检查点源文件路径已变化");
  const input=await fs.open(file,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW|constants.O_NONBLOCK));let output:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{const opened=await input.stat({bigint:true});if(!identity(before,opened))throw Error("检查点源文件已变化");
    if(options.output)output=await fs.open(options.output,"wx",0o600);const hash=createHash("sha256"),buffer=Buffer.allocUnsafe(256*1024);let count=0;
    for(;;){options.signal?.throwIfAborted();const chunk=await input.read(buffer,0,buffer.length,null);if(!chunk.bytesRead)break;count+=chunk.bytesRead;if(BigInt(count)>before.size||!Number.isSafeInteger(count))throw Error("检查点源文件已变化");
      const bytes=buffer.subarray(0,chunk.bytesRead);hash.update(bytes);if(output){let at=0;while(at<bytes.length){const part=await output.write(bytes,at,bytes.length-at,null);if(!part.bytesWritten)throw Error("检查点文件无法完整写入");at+=part.bytesWritten;}}
      options.progress?.(count);
    }
    options.signal?.throwIfAborted();if(BigInt(count)!==before.size||!identity(opened,await input.stat({bigint:true}))||!identity(opened,await fs.lstat(file,{bigint:true}))||await fs.realpath(file)!==physical)throw Error("检查点源文件已变化");
    if(output)await output.sync();return{bytes:count,sha256:hash.digest("hex"),identity:checkpointStat(before)};
  }finally{await input.close();await output?.close();}
}
export async function checkpointSourcePath(root:string,relative:string){
  const parts=checkpointPath.parse(relative).split("/");let folder=await fs.realpath(root);
  for(const part of parts.slice(0,-1)){const candidate=path.join(folder,part);const stat=await fs.lstat(candidate),physical=await fs.realpath(candidate);if(stat.isSymbolicLink()||!stat.isDirectory()||!sameCheckpointPath(physical,candidate))throw Error("检查点路径包含链接或目录变化");folder=physical;}
  const target=path.join(folder,parts.at(-1)!);if(!insideCheckpoint(await fs.realpath(root),target))throw Error("检查点路径超出工作区");return target;
}
export async function checkpointOutputPath(root:string,relative:string){
  const parts=checkpointPath.parse(relative).split("/");const base=await fs.realpath(root);let current=base;
  for(const part of parts.slice(0,-1)){current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    if((await fs.lstat(current)).isSymbolicLink()||await fs.realpath(current)!==current||!insideCheckpoint(base,current))throw Error("检查点目标目录已变化");}
  return path.join(current,parts.at(-1)!);
}
export async function verifyCheckpointFile(root:string,file:CheckpointStoredFile,signal?:AbortSignal){const target=await checkpointSourcePath(root,file.path),actual=await checkpointFingerprint(target,{signal});if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw Error("检查点存储文件完整性校验未通过");return actual;}
