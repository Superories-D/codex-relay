import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import os from "node:os";
import {ProjectGit} from "../src/server/project-git";
import {ServerRuntime} from "../src/server/runtime";
import {openHttp} from "../src/server/http";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {createHash} from "node:crypto";
const execute=promisify(execFile);
describe.skipIf(process.platform!=="linux")("read-only project Git",()=>{
  let root:string,project:string,data:string,inspect:ProjectGit;
  const git=(...args:string[])=>execute("git",["-C",project,...args]);
  const write=(file:string,text:string)=>fs.writeFile(path.join(project,file),text);
  beforeEach(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-project-git-"));project=path.join(root,"project");data=path.join(root,"private");await fs.mkdir(project);await fs.mkdir(data,{mode:0o700});
    await git("init","-b","main");await git("config","user.name","QA");await git("config","user.email","qa@invalid.local");await git("config","core.autocrlf","false");inspect=new ProjectGit(data,[project]);
  });
  afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
  it("separates index, working and new-file evidence without changing repository bytes",async()=>{
    await write("日本語 spaced.txt","base\n");await write("gone.txt","deleted base\n");await git("add","-A");await git("commit","-m","Base");
    await write("日本語 spaced.txt","staged\n");await git("add","日本語 spaced.txt");await write("日本語 spaced.txt","working\n");await write("new.txt","new bytes\n");await fs.rm(path.join(project,"gone.txt"));
    const before=await fs.readFile(path.join(project,".git/index")),config=await fs.readFile(path.join(project,".git/config"));
    const status=await inspect.changes(project);expect(status).toMatchObject({root:project,branch:"main",total:3,truncated:false});expect(status.files.find(file=>file.path==="日本語 spaced.txt")).toMatchObject({index:"M",worktree:"M"});
    expect((await inspect.diff(project,"日本語 spaced.txt",true)).text).toContain("+staged");
    const working=await inspect.diff(project,"日本語 spaced.txt");expect(working.text).toContain("-staged");expect(working.text).toContain("+working");
    expect((await inspect.diff(project,"new.txt")).text).toContain("+new bytes");expect((await inspect.diff(project,"gone.txt")).text).toContain("-deleted base");
    expect(await fs.readFile(path.join(project,".git/index"))).toEqual(before);expect(await fs.readFile(path.join(project,".git/config"))).toEqual(config);expect(await fs.readFile(path.join(project,"日本語 spaced.txt"),"utf8")).toBe("working\n");
  });
  it("supports unborn repositories and bounds the visible inventory",async()=>{
    await Promise.all(Array.from({length:501},(_,index)=>write(`file-${index}.txt`,"new")));
    const status=await inspect.changes(project);expect(status).toMatchObject({head:"",branch:"main",total:501,truncated:true});expect(status.files).toHaveLength(500);
    expect((await inspect.diff(project,"file-0.txt")).text).toBe("+new");
  });
  it.each(["split","sparse"])("preserves %s index state while reading changes",async kind=>{
    await fs.mkdir(path.join(project,"keep"));await fs.mkdir(path.join(project,"hidden"));await write("keep/a.txt","base\n");await write("hidden/b.txt","hidden\n");await git("add","-A");await git("commit","-m","Base");
    if(kind==="split")await git("update-index","--split-index");
    else {await git("sparse-checkout","init","--cone","--sparse-index");await git("sparse-checkout","set","keep");}
    await write("keep/a.txt","changed\n");const before=await fs.readFile(path.join(project,".git/index"));
    expect((await inspect.changes(project)).files.map(file=>file.path)).toEqual(["keep/a.txt"]);expect((await inspect.diff(project,"keep/a.txt")).text).toContain("+changed");expect(await fs.readFile(path.join(project,".git/index"))).toEqual(before);
  });
  it("does not invoke configured clean filters, text converters, external diffs or filesystem monitors",async()=>{
    await write(".gitattributes","*.txt filter=unsafe diff=unsafe\n");await write("a.txt","base\n");await git("add","-A");await git("commit","-m","Base");
    const marker=path.join(root,"executed"),script=path.join(root,"unsafe.cjs");await fs.writeFile(script,`require('node:fs').appendFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);`);
    const command=`"${process.execPath}" "${script}"`;
    for(const key of ["filter.unsafe.clean","filter.unsafe.smudge","filter.unsafe.process","diff.unsafe.textconv","diff.unsafe.command","core.fsmonitor"])await git("config",key,command);
    await git("config","filter.unsafe.required","true");await write("a.txt","raw working\n");
    expect((await inspect.changes(project)).files.map(file=>file.path)).toContain("a.txt");expect((await inspect.diff(project,"a.txt")).text).toContain("+raw working");await expect(fs.access(marker)).rejects.toThrow();
  });
  it("does not read a tracked file through a replaced parent into another directory",async()=>{
    await fs.mkdir(path.join(project,"folder"));await write("folder/a.txt","base\n");await git("add","-A");await git("commit","-m","Base");
    const outside=path.join(root,"outside");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"a.txt"),"Private outside content");await fs.rm(path.join(project,"folder"),{recursive:true});await fs.symlink(outside,path.join(project,"folder"));
    await expect(inspect.diff(project,"folder/a.txt")).rejects.toThrow();expect(await fs.readdir(path.join(data,"project-inspections"))).toEqual([]);
  });
  it("refuses linked, oversized, private-metadata and out-of-scope targets",async()=>{
    const privateFile=path.join(data,"private.txt");await fs.writeFile(privateFile,"Private state");await fs.link(privateFile,path.join(project,"linked.txt"));await fs.symlink(privateFile,path.join(project,"symlink.txt"));await write("large.txt","x".repeat(2*1024*1024+1));
    for(const file of ["linked.txt","symlink.txt","large.txt"])await expect(inspect.diff(project,file)).rejects.toThrow();
    await expect(inspect.diff(project,"../private/private.txt")).rejects.toThrow();await expect(inspect.changes(data)).rejects.toThrow("outside");
    const directory=path.join(data,"repository");await execute("git",["init",directory]);await fs.rm(path.join(project,".git"),{recursive:true});await fs.writeFile(path.join(project,".git"),`gitdir: ${directory}/.git\n`);
    await expect(inspect.changes(project)).rejects.toThrow("元数据范围");
  });
  it("does not expand permission to a parent repository from an allowed subdirectory",async()=>{
    const child=path.join(project,"child");await fs.mkdir(child);await expect(new ProjectGit(data,[child]).changes(child)).rejects.toThrow("outside");
  });
  it("lists nested repositories as directories without confusing their files with the parent",async()=>{
    const nested=path.join(project,"nested");await fs.mkdir(nested);await execute("git",["init",nested]);await fs.writeFile(path.join(nested,"inside.txt"),"Nested work");
    expect((await inspect.changes(project)).files).toContainEqual({path:"nested",index:"?",worktree:"?",directory:true});await expect(inspect.diff(project,"nested")).rejects.toThrow("单独配置");
  });
  it("reads staged renames and SHA-256 repositories without modifying the source index",async()=>{
    await fs.rm(path.join(project,".git"),{recursive:true});await git("init","--object-format=sha256","-b","main");await git("config","user.name","QA");await git("config","user.email","qa@invalid.local");
    await write("old.txt","base\n");await git("add","old.txt");await git("commit","-m","Base");await git("mv","old.txt","new.txt");const before=await fs.readFile(path.join(project,".git/index"));
    const view=await inspect.changes(project);expect(view.head).toHaveLength(64);expect(view.files).toContainEqual({path:"new.txt",index:"R",worktree:" ",original:"old.txt"});
    expect((await inspect.diff(project,"new.txt",true)).text).toContain("rename from old.txt");expect(await fs.readFile(path.join(project,".git/index"))).toEqual(before);
  });
  it("exposes bounded reads through authenticated HTTP while retaining workspace boundaries",async()=>{
    await write("a.txt","base\n");await git("add","a.txt");await git("commit","-m","Base");await write("a.txt","working\n");
    const runtime=await ServerRuntime.open(data,undefined,[project]),web=await openHttp(runtime,0,[project]);
    try {
      const base=`http://127.0.0.1:${(web.server.address() as any).port}`,token=await fs.readFile(path.join(data,"http-token"),"utf8");
      const call=(name:string,args:unknown,credential=token)=>fetch(base+"/api/command",{method:"POST",headers:{Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},body:JSON.stringify({name,args})});
      const changes=await call("project.changes",{cwd:project});expect(changes.ok).toBe(true);expect((await changes.json()).result.files).toContainEqual({path:"a.txt",index:" ",worktree:"M"});
      const diff=await call("project.diff",{cwd:project,path:"a.txt"});expect(diff.ok).toBe(true);expect((await diff.json()).result.text).toContain("+working");
      for(const args of [{cwd:data,path:"http-token"},{cwd:project,path:"../private/http-token"}]){const rejected=await call("project.diff",args);expect(rejected.ok).toBe(false);expect(await rejected.text()).not.toContain(token);}
      expect((await call("project.changes",{cwd:project},"0".repeat(64))).status).toBe(401);expect(runtime.store.data.jobs).toHaveLength(0);
    }finally{await web.close();await runtime.close();}
  });
  it("marks binary and non-UTF-8 previews instead of silently replacing source bytes",async()=>{
    await write("legacy.txt","base\n");await git("add","legacy.txt");await git("commit","-m","Base");
    await fs.writeFile(path.join(project,"legacy.txt"),Buffer.from([0x63,0x61,0x66,0xe9,10]));await fs.writeFile(path.join(project,"encoded.txt"),Buffer.from([0xff,0xfe,0x41]));await fs.writeFile(path.join(project,"binary.bin"),Buffer.from([0,1,255]));
    for(const file of ["legacy.txt","encoded.txt"]){const diff=await inspect.diff(project,file);expect(diff).toMatchObject({preview:"encoded"});expect(diff.text).not.toContain("\uFFFD");expect(diff.text).toContain("preview omitted");}
    expect(await inspect.diff(project,"binary.bin")).toMatchObject({preview:"binary"});
  });
  it("rechecks the workspace before publishing a listing after the root is replaced",async()=>{
    const replacement=path.join(data,"replacement");await fs.mkdir(replacement);await execute("git",["init",replacement]);await fs.writeFile(path.join(replacement,"private-filename.txt"),"Private contents");
    const original=CheckpointGit.prototype.run;let swapped=false;
    vi.spyOn(CheckpointGit.prototype,"run").mockImplementation(async function(this:CheckpointGit,cwd,args,options){
      if(!swapped&&args[0]==="status"&&options?.env?.GIT_DIR?.includes("project-inspections")){swapped=true;await fs.rename(project,path.join(root,"original-project"));await fs.symlink(replacement,project);}
      return original.call(this,cwd,args,options);
    });
    await expect(inspect.changes(project)).rejects.toThrow();expect(swapped).toBe(true);expect(await fs.readdir(path.join(data,"project-inspections"))).toEqual([]);
  });
  it("keeps racy stat-cache entries dirty when inspecting an index copy",async()=>{
    await fs.rm(path.join(project,".git"),{recursive:true});await git("init","--object-format=sha1","-b","main");await git("config","user.name","QA");await git("config","user.email","qa@invalid.local");
    const file=path.join(project,"a.txt"),index=path.join(project,".git/index"),time=1600000000;
    await fs.writeFile(file,"base\n");await git("add","a.txt");await git("commit","-m","Base");await git("update-index","--index-version=2");await fs.writeFile(file,"work\n");await fs.utimes(file,time,time);
    // Preserve the old blob while making its cached stat match the new bytes.
    // A source index with the same mtime is racy and Git must hash the file.
    const stat=await fs.stat(file,{bigint:true}),bytes=await fs.readFile(index);expect(bytes.readUInt32BE(4)).toBe(2);expect(bytes.readUInt32BE(8)).toBe(1);
    const fields=[stat.ctimeNs/1000000000n,stat.ctimeNs%1000000000n,stat.mtimeNs/1000000000n,stat.mtimeNs%1000000000n,stat.dev,stat.ino,stat.mode,stat.uid,stat.gid,stat.size];
    fields.forEach((field,position)=>bytes.writeUInt32BE(Number(field&0xffffffffn),12+position*4));createHash("sha1").update(bytes.subarray(0,-20)).digest().copy(bytes,bytes.length-20);await fs.writeFile(index,bytes);await fs.utimes(index,time,time);
    const original=await execute("git",["-C",project,"status","--porcelain=v1"],{env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}});expect(original.stdout).toContain(" M a.txt");
    expect((await inspect.changes(project)).files).toContainEqual({path:"a.txt",index:" ",worktree:"M"});expect((await inspect.diff(project,"a.txt")).text).toContain("+work");expect(await fs.readFile(index)).toEqual(bytes);
  });
});
