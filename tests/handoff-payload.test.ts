import os from "node:os";
import {beforeAll} from "vitest";
import {afterEach,beforeEach,it,expect} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-handoff-qa");
beforeAll(async()=>{await fs.mkdir(fixtureParent,{recursive:true});});
import {Readable} from "node:stream";
import {createHash} from "node:crypto";
import {extractHandoffBlobs,type HandoffBlob} from "../src/main/handoff-payload";
let root:string;
beforeEach(async()=>{await fs.mkdir(fixtureParent,{recursive:true});root=await fs.mkdtemp(path.join(fixtureParent,"handoff-payload-"));});
afterEach(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-payload-"))throw Error("Unsafe handoff payload cleanup");await fs.rm(actual,{recursive:true,force:true});});
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function object(bytes:Buffer,format:"sha1"|"sha256"="sha1"){const oid=createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");return{oid,bytes:Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`),bytes,Buffer.from("\n")])};}
function chunks(bytes:Buffer){return Readable.from((function*(){for(let at=0;at<bytes.length;at+=137)yield bytes.subarray(at,at+137);})());}
it("streams complete binary data and split object headers without treating binary newlines or NULs as records",async()=>{
  const bytes=Buffer.alloc(5*1024*1024);for(let index=0;index<bytes.length;index++)bytes[index]=index%256;const data=object(bytes),result=await extractHandoffBlobs(chunks(data.bytes),"sha1",root,[{path:"[日本語]/binary.bin",mode:"100644",kind:"file",materialize:true,oid:data.oid,expectedBytes:bytes.length,expectedSha256:hash(bytes)}]);expect(result[0]).toMatchObject({bytes:bytes.length,sha256:hash(bytes),materialized:true});expect(hash(await fs.readFile(path.join(root,"[日本語]/binary.bin")))).toBe(hash(bytes));
},30000);
it("verifies skipped sparse content in full without materializing it and defers links until ordinary files are complete",async()=>{
  const hidden=object(Buffer.from("hidden bytes")),link=object(Buffer.from("../target")),bytes=Buffer.concat([hidden.bytes,link.bytes]),result=await extractHandoffBlobs(chunks(bytes),"sha1",root,[{path:"hidden",oid:hidden.oid,mode:"100644",kind:"index",materialize:false},{path:"link",oid:link.oid,mode:"120000",kind:"link",materialize:true}]);expect(result[0]).toMatchObject({sha256:hash(Buffer.from("hidden bytes")),materialized:false});expect(result[1].linkTarget).toBe("../target");expect(await fs.readdir(root)).toEqual([]);
});
it("supports SHA-256 objects and zero-byte files",async()=>{
  const bytes=Buffer.alloc(0),data=object(bytes,"sha256"),result=await extractHandoffBlobs(chunks(data.bytes),"sha256",root,[{path:"empty",oid:data.oid,mode:"100644",kind:"file",materialize:true}]);expect(result[0].bytes).toBe(0);expect((await fs.stat(path.join(root,"empty"))).size).toBe(0);
});
it("rejects truncated, mismatched and trailing payloads instead of marking partial output complete",async()=>{
  const bytes=Buffer.from("raw bytes"),data=object(bytes),descriptor:HandoffBlob={path:"file",oid:data.oid,mode:"100644",kind:"file",materialize:false};await expect(extractHandoffBlobs(chunks(data.bytes.subarray(0,-2)),"sha1",root,[descriptor])).rejects.toThrow("完整文件字节");const changed=Buffer.from(data.bytes);changed[changed.length-3]^=1;await expect(extractHandoffBlobs(chunks(changed),"sha1",root,[descriptor])).rejects.toThrow("完整字节");await expect(extractHandoffBlobs(chunks(Buffer.concat([data.bytes,Buffer.from("extra")])),"sha1",root,[descriptor])).rejects.toThrow("额外数据");
});
it("never overwrites an existing file or traverses a directory link",async()=>{
  const data=object(Buffer.from("new"));await fs.writeFile(path.join(root,"existing"),"keep");await expect(extractHandoffBlobs(chunks(data.bytes),"sha1",root,[{path:"existing",oid:data.oid,mode:"100644",kind:"file",materialize:true}])).rejects.toThrow();expect(await fs.readFile(path.join(root,"existing"),"utf8")).toBe("keep");const outside=await fs.mkdtemp(path.join(fixtureParent,"handoff-payload-outside-"));try{await fs.symlink(outside,path.join(root,"linked"),"junction");await expect(extractHandoffBlobs(chunks(data.bytes),"sha1",root,[{path:"linked/file",oid:data.oid,mode:"100644",kind:"file",materialize:true}])).rejects.toThrow();expect(await fs.readdir(outside)).toEqual([]);}finally{const actual=await fs.realpath(outside),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-payload-outside-"))throw Error("Unsafe outside payload fixture cleanup");await fs.rm(actual,{recursive:true,force:true});}
});
it("cancels mid-file without returning a verified result",async()=>{
  const data=object(Buffer.alloc(1024*1024,77)),controller=new AbortController();await expect(extractHandoffBlobs(chunks(data.bytes),"sha1",root,[{path:"cancelled",oid:data.oid,mode:"100644",kind:"file",materialize:true}],{signal:controller.signal,progress:(_path,bytes)=>{if(bytes>500)controller.abort();}})).rejects.toThrow();expect((await fs.stat(path.join(root,"cancelled"))).size).toBeLessThan(1024*1024);
});
