import {it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
const {publishPackage}=createRequire(import.meta.url)("../scripts/publish-package.mjs");
it("keeps the prior package on publication failure and serializes publishers",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-package-publish-"));
 const directory=path.join(root,"staged"),output=path.join(root,"published"),archive=path.join(root,"new.tar.gz"),archiveOutput=path.join(root,"published.tar.gz");
 try{
 await fs.mkdir(directory);await fs.mkdir(output);await fs.writeFile(path.join(directory,"new"),"new bytes");await fs.writeFile(path.join(output,"old"),"old bytes");await fs.writeFile(archive,"new archive");await fs.writeFile(archiveOutput,"old archive");
 const rename=vi.fn(async(a:string,b:string)=>{if(a===archive)throw Error("publication unavailable");await fs.rename(a,b);});
 await expect(publishPackage({directory,archive,output,archiveOutput,io:{...fs,rename}})).rejects.toThrow("publication unavailable");
 expect(await fs.readFile(path.join(output,"old"),"utf8")).toBe("old bytes");expect(await fs.readFile(archiveOutput,"utf8")).toBe("old archive");expect(await fs.readFile(path.join(directory,"new"),"utf8")).toBe("new bytes");
 await fs.mkdir(output+".publishing");await expect(publishPackage({directory,archive,output,archiveOutput})).rejects.toMatchObject({code:"EEXIST"});expect(await fs.readFile(archiveOutput,"utf8")).toBe("old archive");await fs.rmdir(output+".publishing");
 await publishPackage({directory,archive,output,archiveOutput});expect(await fs.readFile(path.join(output,"new"),"utf8")).toBe("new bytes");expect(await fs.readFile(archiveOutput,"utf8")).toBe("new archive");expect((await fs.readdir(root)).sort()).toEqual(["published","published.tar.gz"]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
