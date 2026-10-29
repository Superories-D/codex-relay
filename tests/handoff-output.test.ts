import {afterEach,beforeEach,expect,it} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {CheckpointGit} from "../src/main/checkpoint-git";
let root:string,git:CheckpointGit;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"handoff-output-"));git=new CheckpointGit(path.join(root,"commands"),{native:false});await git.run(root,["init"]);});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it("retains a complete batch object when ownership checks delay the consumer until after Git exits",async()=>{
  const body="retained source index\r\n";
  // Store a real object through the input path being merged, then intentionally
  // delay the first read to reproduce ChildProcess's automatic stdout drain.
  const object=(await git.run(root,["hash-object","-w","--stdin"],{input:body})).toString().trim();
  let output="";
  await git.run(root,["cat-file","--batch"],{input:object+"\n",consumeOutput:async stream=>{
    await new Promise(resolve=>setTimeout(resolve,150));
    for await(const chunk of stream)output+=chunk.toString();
  }});
  expect(output).toBe(`${object} blob ${Buffer.byteLength(body)}\n${body}\n`);
});
it("backpressures large object output and rejects a consumer failure without hanging Git",async()=>{
  const body="x".repeat(2*1024*1024+19),object=(await git.run(root,["hash-object","-w","--stdin"],{input:body})).toString().trim();
  let bytes=0;
  await git.run(root,["cat-file","blob",object],{consumeOutput:async stream=>{
    await new Promise(resolve=>setTimeout(resolve,30));for await(const chunk of stream)bytes+=chunk.length;
  }});
  expect(bytes).toBe(Buffer.byteLength(body));
  const failure=Error("review destination unavailable");
  await expect(git.run(root,["cat-file","blob",object],{consumeOutput:async()=>{throw failure;}})).rejects.toBe(failure);
});

it("rejects a consumer that returns before draining large output instead of hanging on backpressure",async()=>{
  const body="y".repeat(2*1024*1024+31),object=(await git.run(root,["hash-object","-w","--stdin"],{input:body})).toString().trim();
  await expect(git.run(root,["cat-file","blob",object],{consumeOutput:async()=>{}})).rejects.toThrow("未读取完整数据");
});
