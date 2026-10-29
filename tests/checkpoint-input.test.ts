import {it,expect} from "vitest";
import {spawn,execFile} from "node:child_process";
import {once} from "node:events";
import {promises as fs} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import os from "node:os";
import {promisify} from "node:util";
import {writeCheckpointInput} from "../src/main/checkpoint-input";

function consumer(code:number) {
  const child=spawn(process.execPath,["-e",`process.stdin.once('data',data=>{process.stdout.write(String(data.length));process.exit(${code});});`],{stdio:["pipe","pipe","pipe"]});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  let output="";child.stdout.on("data",data=>{output+=data;});
  const inputClosed=once(child.stdin,"close");
  return {child,closed,inputClosed,output:()=>output};
}

it("accepts a successful fixed-length consumer that closes before the source EOF arrives",async()=>{
  const process=consumer(0),body=Buffer.from("complete packet");
  async function* source(){yield body;await process.inputClosed;}
  await writeCheckpointInput(process.child.stdin,source(),process.closed);
  expect(await process.closed).toBe(0);expect(process.output()).toBe(String(body.length));
});
it("does not accept a failed consumer even after every data write completed",async()=>{
  const process=consumer(7);
  async function* source(){yield Buffer.from("packet");await process.inputClosed;}
  await expect(writeCheckpointInput(process.child.stdin,source(),process.closed)).rejects.toThrow();
  expect(await process.closed).toBe(7);
});
it("rejects an early successful exit when another source chunk still needs delivery",async()=>{
  const process=consumer(0);
  async function* source(){yield Buffer.from("first");await process.inputClosed;yield Buffer.from("undelivered");}
  await expect(writeCheckpointInput(process.child.stdin,source(),process.closed)).rejects.toThrow();
  expect(await process.closed).toBe(0);expect(process.output()).toBe("5");
});
it("preserves a source read failure even if the consumer already accepted its prefix",async()=>{
  const process=consumer(0),failure=Error("Checkpoint file read failed");
  async function* source(){yield Buffer.from("prefix");await process.inputClosed;throw failure;}
  await expect(writeCheckpointInput(process.child.stdin,source(),process.closed)).rejects.toBe(failure);
  expect(await process.closed).toBe(0);
});
it("imports a real Git pack when index-pack finishes before the source EOF is scheduled",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-pack-eof-"));
  try {
    await promisify(execFile)("git",["init","--object-format=sha1",root]);
    const header=Buffer.from([80,65,67,75,0,0,0,2,0,0,0,0]),pack=Buffer.concat([header,createHash("sha1").update(header).digest()]);
    const child=spawn("git",["-C",root,"index-pack","--stdin","--strict"],{stdio:["pipe","pipe","pipe"]});
    const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    const inputClosed=once(child.stdin,"close");let output="",error="";
    child.stdout.on("data",data=>{output+=data;});child.stderr.on("data",data=>{error+=data;});
    async function* source(){yield pack;await inputClosed;}
    try {
      await writeCheckpointInput(child.stdin,source(),closed);
      expect(await closed,error).toBe(0);expect(output).toMatch(/^pack\s+[a-f0-9]{40}/);
    }finally{if(child.exitCode===null)child.kill();await closed;}
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
