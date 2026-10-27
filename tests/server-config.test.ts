import {expect,it} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {readServerConfig} from "../src/server/config";
it("resolves config-relative directories independently of the launch directory and rejects unknown fields",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-config-")),file=path.join(root,"server.json");
 try{
 await fs.writeFile(file,JSON.stringify({version:1,dataDir:"data",workspaces:["work"],httpPort:0,httpOrigin:"https://Relay.Example/"}));
 expect(await readServerConfig(file)).toMatchObject({dataDir:path.join(root,"data"),workspaces:[path.join(root,"work")],httpPort:0,httpOrigin:"https://relay.example",telegram:false});
 await fs.writeFile(file,JSON.stringify({version:1,httpPort:-1}));await expect(readServerConfig(file)).rejects.toThrow();
 await fs.writeFile(file,JSON.stringify({version:1,token:"mistaken-secret"}));await expect(readServerConfig(file)).rejects.toThrow();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
