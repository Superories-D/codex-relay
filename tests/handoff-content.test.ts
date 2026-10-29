import os from "node:os";
import {beforeAll} from "vitest";
import {it,expect} from "vitest";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import {promises as fs,writeSync} from "node:fs";
import path from "node:path";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-handoff-qa");
beforeAll(async()=>{await fs.mkdir(fixtureParent,{recursive:true});});
import {HandoffContentWindow} from "../src/main/handoff-content";
import {handoffContentSelection} from "../src/shared/handoff";
import {checkpointFingerprint} from "../src/main/checkpoint-file";
import {extractHandoffBlobs} from "../src/main/handoff-payload";
function read(bytes:Buffer,offset:number,length:number,chunkSize=7){const window=new HandoffContentWindow(offset,length);for(let at=0;at<bytes.length;at+=chunkSize)window.observe(bytes.subarray(at,at+chunkSize),at);return window.finish();}
it("preserves exact raw pages and aligns every UTF8 boundary without replacement characters",()=>{
  const text="\uFEFF日😀本\r\nsecond\n最後🦊",bytes=Buffer.from(text);
  for(let offset=0;offset<=bytes.length+4;offset++)for(let length=1;length<9;length++){
    const page=read(bytes,offset,length,1);expect(Buffer.from(page.rawBase64,"base64")).toEqual(bytes.subarray(offset,offset+length));expect(page.encoding).toBe("utf8");expect(page.text).not.toContain("�");expect(Buffer.from(page.text!)).toEqual(bytes.subarray(page.textOffset!,page.textOffset!+page.textBytes!));expect(page.firstLine).toBe(1+bytes.subarray(0,offset).filter(value=>value===10).length);expect(page.eof).toBe(offset+length>=bytes.length);
  }
});
it("classifies the complete file even when invalid UTF8, NUL or a control byte is far outside the page",()=>{
  for(const tail of [Buffer.from([0]),Buffer.from([255]),Buffer.from([0xe2,0x82]),Buffer.from([11]),Buffer.from([127])]){const bytes=Buffer.concat([Buffer.alloc(1024*1024,65),tail]),page=read(bytes,1,8,65536);expect(page).toMatchObject({encoding:"binary",length:8,rawBase64:Buffer.from("AAAAAAAA").toString("base64")});expect(page.text).toBeUndefined();}
});
it("keeps CRLF and empty/beyond-EOF pages exact and refuses discontinuous or reused streams",()=>{
  expect(read(Buffer.from("a\r\nb\n"),1,2).text).toBe("\r\n");expect(read(Buffer.alloc(0),400,16)).toMatchObject({offset:0,length:0,eof:true,encoding:"utf8",text:"",firstLine:1});expect(read(Buffer.from("abc"),999,16)).toMatchObject({offset:3,length:0,eof:true,text:""});const window=new HandoffContentWindow(0,16);expect(()=>window.observe(Buffer.from("x"),1)).toThrow("不连续");window.observe(Buffer.from("a"),0);window.finish();expect(()=>window.finish()).toThrow("已结束");expect(()=>window.observe(Buffer.from("b"),1)).toThrow();
});
it("bounds transport pages and rejects traversal, arbitrary OIDs and incompatible layers",()=>{
  const valid={role:"base",path:"[日本語]/file",layer:"working",offset:0,length:65536};expect(handoffContentSelection.parse(valid).stage).toBe(0);for(const bad of [{length:65537},{offset:Number.MAX_SAFE_INTEGER},{path:"../outside"},{oid:"a".repeat(40)},{role:"base",layer:"edited"},{role:"result",layer:"undo"},{stage:1}])expect(handoffContentSelection.safeParse({...valid,...bad}).success).toBe(false);
});
it("observes complete 5MiB Git objects with independent SHA/OID verification and only returns the requested binary bytes",async()=>{
  const root=await fs.mkdtemp(path.join(fixtureParent,"handoff-content-"));try{
    const bytes=Buffer.alloc(5*1024*1024+13);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
    const sha256=createHash("sha256").update(bytes).digest("hex"),oid=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),data=Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`),bytes,Buffer.from("\n")]),window=new HandoffContentWindow(bytes.length-113,32);
    const result=await extractHandoffBlobs(Readable.from((function*(){for(let i=0;i<data.length;i+=8191)yield data.subarray(i,i+8191);})()),"sha1",root,[{path:"binary",oid,mode:"100644",kind:"file",materialize:false,expectedSha256:sha256}],{observe:(_path,chunk,offset)=>window.observe(chunk,offset)});expect(result[0]).toMatchObject({bytes:bytes.length,sha256,oid});expect(Buffer.from(window.finish().rawBase64,"base64")).toEqual(bytes.subarray(bytes.length-113,bytes.length-81));expect(await fs.readdir(root)).toEqual([]);
  }finally{const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-content-"))throw Error("Unsafe content fixture");await fs.rm(actual,{recursive:true,force:true});}
});
it("does not publish a window after a guarded edited file changes mid-stream or is cancelled",async()=>{
  const root=await fs.mkdtemp(path.join(fixtureParent,"handoff-content-"));try{
    const file=path.join(root,"edited"),bytes=Buffer.alloc(1024*1024,65);await fs.writeFile(file,bytes);const descriptor=await fs.open(file,"r+"),window=new HandoffContentWindow(0,32);let changed=false;
    try{await expect(checkpointFingerprint(file,{observe:window.observe,progress:count=>{if(count>0&&!changed){changed=true;writeSync(descriptor.fd,Buffer.from("changed"),0,7,0);}}})).rejects.toThrow("已变化");}finally{await descriptor.close();}
    await fs.writeFile(file,bytes);const controller=new AbortController();await expect(checkpointFingerprint(file,{signal:controller.signal,observe:new HandoffContentWindow(0,32).observe,progress:()=>controller.abort()})).rejects.toThrow();expect(await fs.readFile(file)).toEqual(bytes);
  }finally{const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-content-"))throw Error("Unsafe content fixture");await fs.rm(actual,{recursive:true,force:true});}
});
