import {TextDecoder} from "node:util";
import type {HandoffContentDocument,HandoffContentSelection,HandoffEntry} from "../shared/handoff";
import {checkpointFingerprint,checkpointSourcePath} from "./checkpoint-file";
import {extractHandoffBlobs} from "./handoff-payload";
import type {HandoffWorkspaceContext} from "./handoff-workspace";
import type {readHandoffArchive} from "./handoff-archive";

/** Full-stream classification with only a bounded byte window retained in memory. */
export class HandoffContentWindow {
  private decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});private text=true;
  private parts:Buffer[]=[];private count=0;private lines=0;private finished=false;
  constructor(private offset:number,private length:number){}
  observe=(chunk:Buffer,offset:number)=>{
    if(this.finished||offset!==this.count)throw Error("内容流的字节位置不连续");this.count+=chunk.length;
    if(!Number.isSafeInteger(this.count))throw Error("内容流的字节位置不连续");
    if(this.text){try{this.decoder.decode(chunk,{stream:true});}catch{this.text=false;}if(chunk.some(byte=>byte<32&&byte!==9&&byte!==10&&byte!==13||byte===127))this.text=false;}
    const before=Math.min(chunk.length,Math.max(0,this.offset-offset));for(let i=0;i<before;i++)if(chunk[i]===10)this.lines++;
    const start=Math.max(0,this.offset-3-offset),end=Math.min(chunk.length,this.offset+this.length+3-offset);
    if(start<end)this.parts.push(Buffer.from(chunk.subarray(start,end)));
  };
  finish():NonNullable<HandoffContentDocument["window"]>{
    if(this.finished)throw Error("内容窗口已结束");this.finished=true;
    if(this.text)try{this.decoder.decode();}catch{this.text=false;}
    const bytes=Buffer.concat(this.parts),origin=Math.min(this.count,Math.max(0,this.offset-3)),start=Math.min(this.count,this.offset),end=Math.min(this.count,this.offset+this.length),from=start-origin,to=end-origin,raw=bytes.subarray(from,to);
    const result:NonNullable<HandoffContentDocument["window"]>={offset:start,length:raw.length,rawBase64:raw.toString("base64"),eof:end===this.count,encoding:this.text?"utf8":"binary"};
    if(this.text){let left=from,right=to;if(raw.length){while(left>0&&(bytes[left]&192)===128)left--;while(right<bytes.length&&(bytes[right]&192)===128)right++;}
      result.text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes.subarray(left,right));result.textOffset=origin+left;result.textBytes=right-left;result.firstLine=this.lines+1;
    }return result;
  }
}

type ContentContext=HandoffWorkspaceContext&{readWorkspace:(id:string)=>Promise<import("../shared/handoff").HandoffWorkspace>;archiveMetadata:(id:string)=>ReturnType<typeof readHandoffArchive>};
/** Resolve only manifest-owned paths/stages. Renderer-provided object IDs never enter Git. */
export async function readHandoffContent(context:ContentContext,entry:Pick<HandoffEntry,"archives"|"snapshots"|"currentWorkspaceId">,selection:HandoffContentSelection):Promise<HandoffContentDocument>{
  const document:HandoffContentDocument={selection,kind:"absent"},window=new HandoffContentWindow(selection.offset,selection.length);
  const progress=(bytes:number)=>context.progress?.({phase:"hashing",path:selection.path,bytes,files:0,totalFiles:1});
  const object=async(value:{mode:string;oid:string;bytes?:number;sha256?:string})=>{
    document.mode=value.mode;document.oid=value.oid;
    if(value.mode==="160000"||value.mode==="040000"){document.kind=value.mode==="160000"?"gitlink":"tree";return document;}
    const results:Awaited<ReturnType<typeof extractHandoffBlobs>>=[];
    await context.call(["cat-file","--batch"],{input:value.oid+"\n",consumeOutput:async stream=>{results.push(...await extractHandoffBlobs(stream,context.format,context.directory,[{path:selection.path,oid:value.oid,mode:value.mode as "100644"|"100755"|"120000",kind:value.mode==="120000"?"link":"file",materialize:false,expectedBytes:value.bytes,expectedSha256:value.sha256}],{signal:context.signal,observe:(_path,chunk,offset)=>window.observe(chunk,offset),progress:(_path,bytes)=>progress(bytes)}));}});
    const result=results[0];await context.assertOwned();context.signal?.throwIfAborted();return{...document,kind:value.mode==="120000"?"link" as const:"file" as const,bytes:result.bytes,sha256:result.sha256,linkTarget:result.linkTarget,window:window.finish()};
  };
  if(selection.role!=="result"){
    const role=selection.role,saved=await context.archiveMetadata(entry.archives[role]),snapshot=await context.readSnapshot(entry.snapshots[role]),node=saved.manifest.repos.find(value=>value.id===snapshot.repositoryId);
    if(!node||node.relative!==snapshot.relative||saved.archive.role!==role||snapshot.role!==role||snapshot.manifestSha256!==saved.archive.manifestSha256)throw Error("内容来源与交接封存不一致");
    if(selection.layer==="index"||selection.layer==="undo"){
      const stage=(selection.layer==="index"?node.stages:node.undo).find(value=>value.path===selection.path&&value.stage===selection.stage);
      if(stage)return object(stage);
      // Sparse directory indexes expand into known snapshot members, never arbitrary paths.
      if(selection.layer==="index"&&selection.stage===0){const member=snapshot.members.find(value=>value.path===selection.path&&value.kind==="index");if(member)return object(member);}
      return document;
    }
    const member=snapshot.members.find(value=>value.path===selection.path);if(member)return object({...member,...(member.kind==="gitlink"||member.kind==="index"?{bytes:undefined,sha256:undefined}:{})});
    const setup=node.files.find(value=>value.path===selection.path&&value.ignored);
    if(setup?.kind==="link")return{...document,kind:"link",linkTarget:setup.link?.target};
    if(!setup?.stored)return document;
    const actual=await checkpointFingerprint(await checkpointSourcePath(saved.root,setup.stored.path),{signal:context.signal,observe:window.observe,progress});
    if(actual.bytes!==setup.stored.bytes||actual.sha256!==setup.stored.sha256)throw Error("内容来源与交接封存不一致");await context.assertOwned();return{...document,kind:"file",bytes:actual.bytes,sha256:actual.sha256,window:window.finish()};
  }
  if(!entry.currentWorkspaceId)return document;
  const workspace=await context.readWorkspace(entry.currentWorkspaceId);document.workspaceId=workspace.id;
  if(selection.layer==="index"&&selection.stage>0){const stage=workspace.conflicts.find(value=>value.path===selection.path&&value.stage===selection.stage);return stage?object(stage):document;}
  if(selection.layer==="index"&&workspace.conflicts.some(value=>value.path===selection.path))return document;
  const file=workspace.files.find(value=>value.path===selection.path);
  if(selection.layer!=="edited")return file?object({...file,...(file.disposition==="sparse"||file.disposition==="gitlink"?{bytes:undefined,sha256:undefined}:{})}):document;
  // No arbitrary untracked path reads, and no following native links or gitlinks.
  if(!file)return document;
  if(file.disposition!=="file")return{...document,mode:file.mode,oid:file.oid,kind:file.disposition==="sparse"?"sparse":file.disposition==="gitlink"?"gitlink":"link",linkTarget:file.linkTarget};
  let target:string;try{target=await checkpointSourcePath(workspace.target,selection.path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return document;throw error;}
  let actual:Awaited<ReturnType<typeof checkpointFingerprint>>;
  try{actual=await checkpointFingerprint(target,{signal:context.signal,gitFormat:context.format,observe:window.observe,progress});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return document;throw error;}
  await context.readWorkspace(workspace.id);context.signal?.throwIfAborted();return{...document,kind:"file",mode:file.mode,oid:actual.gitOid,bytes:actual.bytes,sha256:actual.sha256,identity:actual.identity,window:window.finish()};
}
