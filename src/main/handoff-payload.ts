import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {TextDecoder} from "node:util";
import type {Readable} from "node:stream";
import {checkpointPath,checkpointOid} from "../shared/checkpoints";
import type {HandoffObjectFormat} from "../shared/handoff";
import {checkpointOutputPath,sameCheckpointPath} from "./checkpoint-file";
import {handoffWriteAll} from "./handoff-stream";

export interface HandoffBlob {
  path:string;oid:string;mode:"100644"|"100755"|"120000";
  kind:"file"|"index"|"link";materialize:boolean;expectedBytes?:number;expectedSha256?:string;
}
export interface HandoffExtractedBlob {
  path:string;oid:string;mode:HandoffBlob["mode"];bytes:number;sha256:string;materialized:boolean;
  /** Actual filesystem links are created only after every regular file is written. */
  linkTarget?:string;
}
class Cursor {
  private iterator:AsyncIterator<Buffer>;private current=Buffer.alloc(0);private offset=0;private ended=false;
  constructor(stream:Readable,private signal?:AbortSignal){this.iterator=stream[Symbol.asyncIterator]();}
  private async available():Promise<boolean>{
    this.signal?.throwIfAborted();if(this.offset<this.current.length)return true;if(this.ended)return false;
    const next=await this.iterator.next();if(next.done){this.ended=true;return false;}this.current=Buffer.from(next.value);this.offset=0;return this.available();
  }
  async line(){const parts:Buffer[]=[];let length=0;for(;;){if(!await this.available())throw Error("交接对象流缺少完整对象头");const end=this.current.indexOf(10,this.offset);if(end>=0){const tail=this.current.subarray(this.offset,end);this.offset=end+1;return Buffer.concat([...parts,tail],length+tail.length);}const tail=this.current.subarray(this.offset);parts.push(tail);length+=tail.length;this.offset=this.current.length;}}
  async body(size:number,consume:(chunk:Buffer)=>Promise<void>){let left=size;while(left){if(!await this.available())throw Error("交接对象流缺少完整文件字节");const length=Math.min(left,this.current.length-this.offset),chunk=this.current.subarray(this.offset,this.offset+length);this.offset+=length;left-=length;await consume(chunk);}}
  async newline(){if(!await this.available()||this.current[this.offset++]!==10)throw Error("交接对象流缺少文件终止符");}
  async finish(){if(await this.available())throw Error("交接对象流包含未记录的额外数据");}
  async close(){await this.iterator.return?.();}
}

/** Stream Git's binary batch protocol; file sizes never enter a text buffer. */
export async function extractHandoffBlobs(stream:Readable,format:HandoffObjectFormat,root:string,blobs:HandoffBlob[],options:{signal?:AbortSignal;observe?:(path:string,chunk:Buffer,offset:number)=>void;progress?:(path:string,bytes:number)=>void}={}){
  const physical=await fs.realpath(root);if(!sameCheckpointPath(root,physical)||(await fs.lstat(root)).isSymbolicLink())throw Error("交接工作区目录归属已变化");
  const names=new Set<string>();for(const blob of blobs){checkpointPath.parse(blob.path);checkpointOid.parse(blob.oid);if(blob.oid.length!==(format==="sha1"?40:64))throw Error("交接对象格式不一致");const key=process.platform==="win32"?blob.path.toLowerCase():blob.path;if(names.has(key))throw Error("交接文件路径存在冲突");names.add(key);}
  for(const name of names){let parent=name;while(parent.includes("/")){parent=parent.slice(0,parent.lastIndexOf("/"));if(names.has(parent))throw Error("交接文件与目录路径存在冲突");}}
  const cursor=new Cursor(stream,options.signal),result:HandoffExtractedBlob[]=[],decoder=new TextDecoder("utf-8",{fatal:true});
  try{
    for(const blob of blobs){
      options.signal?.throwIfAborted();const header=decoder.decode(await cursor.line()),match=/^([a-f0-9]{40,64}) blob (0|[1-9]\d*)$/.exec(header),size=match?Number(match[2]):-1;
      if(!match||match[1]!==blob.oid||!Number.isSafeInteger(size)||size<0||blob.expectedBytes!==undefined&&blob.expectedBytes!==size)throw Error("交接对象头与提案清单不一致");
      const gitHash=createHash(format).update(`blob ${size}\0`),sha=createHash("sha256"),linkParts:Buffer[]=[];let written=0,handle:Awaited<ReturnType<typeof fs.open>>|undefined;
      // A native link target is intrinsically a Windows path; large ordinary
      // files and symlink stubs still stream without this path-only constraint.
      if(blob.kind==="link"&&size>4*32767)throw Error("交接链接目标无法在 Windows 上表示");
      if(blob.materialize&&blob.kind!=="link")handle=await fs.open(await checkpointOutputPath(root,blob.path),"wx",0o600);
      try{
        await cursor.body(size,async bytes=>{options.signal?.throwIfAborted();gitHash.update(bytes);sha.update(bytes);if(handle)await handoffWriteAll(handle,bytes);if(blob.kind==="link")linkParts.push(Buffer.from(bytes));options.observe?.(blob.path,bytes,written);written+=bytes.length;options.progress?.(blob.path,written);});await cursor.newline();
        const actualOid=gitHash.digest("hex"),sha256=sha.digest("hex");if(actualOid!==blob.oid||blob.expectedSha256&&sha256!==blob.expectedSha256)throw Error("交接文件完整字节与提案对象不一致");
        if(handle)await handle.sync();const linkTarget=blob.kind==="link"?decoder.decode(Buffer.concat(linkParts)):undefined;if(linkTarget!==undefined&&(!linkTarget||linkTarget.length>32767||linkTarget.includes("\0")))throw Error("交接链接目标无法在 Windows 上表示");
        result.push({path:blob.path,oid:blob.oid,mode:blob.mode,bytes:size,sha256,materialized:blob.materialize&&blob.kind!=="link",...(linkTarget!==undefined?{linkTarget}:{})});
      }finally{await handle?.close();}
    }
    await cursor.finish();options.signal?.throwIfAborted();return result;
  }finally{await cursor.close();}
}
