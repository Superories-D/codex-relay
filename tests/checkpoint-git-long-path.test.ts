import {it,expect} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {prepareCheckpoint,captureCheckpointFiles,assertCheckpointSource} from "../src/main/checkpoint-capture";
it.skipIf(process.platform!=="win32")("captures through actual managed Git with complete Unicode inspection/index paths beyond 260 characters",async()=>{
  const parent=await fs.realpath("D:/cooperate/codex-relay-qa"),fixture=await fs.mkdtemp(path.join(parent,"checkpoint-long-git-")),controller=new AbortController();await fs.writeFile(path.join(fixture,".owner"),fixture);
  try{
    const root=path.join(fixture,"Project"),git=new CheckpointGit(path.join(fixture,"commands"),{native:false,signal:controller.signal});await fs.mkdir(root);await git.run(root,["init","-b","main"]);await git.run(root,["config","user.name","QA"]);await git.run(root,["config","user.email","qa@localhost"]);await git.run(root,["config","core.autocrlf","false"]);await fs.writeFile(path.join(root,"raw.txt"),"index original\r\n");await git.run(root,["add","raw.txt"]);await git.run(root,["commit","-m","Base"]);const originalIndex=await fs.readFile(path.join(root,".git/index")),originalHead=await git.text(root,["rev-parse","HEAD"]),raw=Buffer.alloc(1024*1024+37,177);raw[raw.length-1]=31;await fs.writeFile(path.join(root,"raw.txt"),raw);
    let storage=path.join(fixture,"Saved");while(storage.length<300)storage=path.join(storage,"保留完整目录-日本語-long-storage");await fs.mkdir(storage,{recursive:true});const options={root:storage,native:true,signal:controller.signal},prepared=await prepareCheckpoint(root,"Long metadata capture",options);expect(prepared.listings[0].env.GIT_DIR!.length).toBeGreaterThan(260);expect(prepared.listings[0].env.GIT_INDEX_FILE!.length).toBeGreaterThan(260);const manifest=await captureCheckpointFiles(prepared,options),stored=manifest.repos[0].files.find(file=>file.path==="raw.txt")!.stored!;expect(await fs.readFile(path.join(storage,stored.path))).toEqual(raw);expect(await fs.readFile(path.join(storage,manifest.repos[0].index!.path))).toEqual(originalIndex);await assertCheckpointSource(prepared,options,true);expect(await fs.readFile(path.join(root,".git/index"))).toEqual(originalIndex);expect(await git.text(root,["rev-parse","HEAD"])).toBe(originalHead);expect(await fs.readFile(path.join(root,"raw.txt"))).toEqual(raw);
  }finally{
    controller.abort();const actual=await fs.realpath(fixture);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("checkpoint-long-git-")||await fs.readFile(path.join(actual,".owner"),"utf8")!==fixture)throw Error("Unsafe long Git fixture cleanup");await fs.rm(actual,{recursive:true,force:true});
  }
},180000);
