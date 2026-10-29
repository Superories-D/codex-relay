import os from "node:os";
import {beforeAll} from "vitest";
import {afterEach,beforeEach,it,expect} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-handoff-qa");
beforeAll(async()=>{await fs.mkdir(fixtureParent,{recursive:true});});
import {parseHandoffMerge} from "../src/main/handoff-merge";
let root:string;
const oid="1".repeat(40),other="2".repeat(40);
beforeEach(async()=>{await fs.mkdir(fixtureParent,{recursive:true});root=await fs.mkdtemp(path.join(fixtureParent,"handoff-parser-"));});
afterEach(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-parser-"))throw Error("Unsafe handoff parser cleanup");await fs.rm(actual,{recursive:true,force:true});});
async function parse(records:string[],code:0|1=1){const file=path.join(root,"output.nul");await fs.writeFile(file,records.join("\0")+"\0");return parseHandoffMerge(file,"sha1",code);}
it("preserves real conflict stages and complete structured messages, including Unicode and multiline text",async()=>{
  const result=await parse([oid,`100644 ${other} 1\t[日本語].txt`,`100644 ${other} 2\t[日本語].txt`,`100644 ${other} 3\t[日本語].txt`,"","1","[日本語].txt","CONFLICT (contents)","Conflict\nmore context\n"]);expect(result.status).toBe("conflicted");expect(result.conflicts.map(entry=>entry.stage)).toEqual([1,2,3]);expect(result.messages[0].text).toBe("Conflict\nmore context\n");
});
it("retains structural conflicts even when Git has no unmerged file-stage records",async()=>{
  const result=await parse([oid,"","0","CONFLICT (directory rename suggested)","Review repository structure"]);expect(result.status).toBe("conflicted");expect(result.conflicts).toEqual([]);expect(result.messages[0].paths).toEqual([]);
});
it("accepts only a complete tree record for a successful computation",async()=>{
  expect((await parse([oid],0)).status).toBe("clean");await expect(parse([oid,"unexpected"],0)).rejects.toThrow("未解释");
});
it.each([
  [oid,`100644 ${other} 2\tfile`,`100644 ${other} 2\tfile`,""],
  [oid,`100644 ${"2".repeat(64)} 1\tfile`,""],
  [oid,`100644 ${other} 1\t../outside`,""],
  [oid,"","2","file","CONFLICT (contents)"],
  [oid,"","not-a-count"],
  [oid,""],
].map(records=>({records})))("rejects malformed or incomplete conflict evidence %#",async({records})=>{await expect(parse(records)).rejects.toThrow();});
it("does not silently replace invalid UTF8 or accept a missing terminal NUL",async()=>{
  const file=path.join(root,"invalid.nul");await fs.writeFile(file,Buffer.concat([Buffer.from(oid+"\0\0"),Buffer.from([255,0])]));await expect(parseHandoffMerge(file,"sha1",1)).rejects.toThrow();await fs.writeFile(file,oid);await expect(parseHandoffMerge(file,"sha1",0)).rejects.toThrow("终止符");
});
it("streams conflict inventories larger than the small-metadata buffer without dropping paths",async()=>{
  const records=[oid,...Array.from({length:20000},(_,i)=>`100644 ${other} 1\tfile-${i}.txt`),"","1","file-0.txt","CONFLICT (contents)","Many conflicts"],file=path.join(root,"large.nul");await fs.writeFile(file,records.join("\0")+"\0");expect((await fs.stat(file)).size).toBeGreaterThan(1024*1024);expect((await parseHandoffMerge(file,"sha1",1)).conflicts).toHaveLength(20000);
});
it("cancels before consuming a result and releases the underlying read stream",async()=>{
  const file=path.join(root,"cancel.nul");await fs.writeFile(file,oid+"\0");const controller=new AbortController();controller.abort();await expect(parseHandoffMerge(file,"sha1",0,controller.signal)).rejects.toThrow();await fs.rm(file);
});
