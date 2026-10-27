import {it,expect} from "vitest";
import {publicHttpOrigin,permittedRequestHost,permittedRequestOrigin} from "../src/server/http-origin";
import {ServerRuntime} from "../src/server/runtime";
import {openHttp} from "../src/server/http";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
it("accepts only exact explicit HTTPS origins and leaves local-only defaults intact",()=>{
 const origin=publicHttpOrigin("https://Relay.Example:8443/");expect(origin).toBe("https://relay.example:8443");
 for(const value of ["http://relay.example","https://user:pass@relay.example","https://relay.example/path","https://relay.example?token=x","https://relay.example/#x","*"])expect(()=>publicHttpOrigin(value)).toThrow();
 expect(permittedRequestHost("relay.example:8443")).toBe(false);expect(permittedRequestHost("relay.example:8443",origin)).toBe(true);expect(permittedRequestHost("relay.example.attacker:8443",origin)).toBe(false);
 expect(permittedRequestOrigin("127.0.0.1:7899",origin,origin)).toBe(true);expect(permittedRequestOrigin("relay.example:8443","http://relay.example:8443",origin)).toBe(false);expect(permittedRequestOrigin("relay.example:8443","https://attacker",origin)).toBe(false);
});
it.skipIf(process.platform!=="linux")("serves authenticated commands through an explicitly configured HTTPS proxy origin",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-origin-")),runtime=await ServerRuntime.open(root);
 const web=await openHttp(runtime,0,[],undefined,"https://relay.example");
 try{
 const token=await fs.readFile(path.join(root,"http-token"),"utf8"),port=(web.server.address() as any).port;
 const post=(host:string,origin:string,authorized=true)=>new Promise<{status?:number;body:any}>((resolve,reject)=>{const req=http.request({host:"127.0.0.1",port,path:"/api/command",method:"POST",headers:{Host:host,Origin:origin,"Content-Type":"application/json",...(authorized?{Authorization:`Bearer ${token}`}:{})}},res=>{let data="";res.on("data",c=>data+=c);res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on("error",reject);req.end(JSON.stringify({name:"health"}));});
 expect((await post("relay.example","https://relay.example")).status).toBe(200);
 expect((await post("127.0.0.1:"+port,"https://relay.example")).status).toBe(200);
 expect((await post("relay.example","https://relay.example",false)).status).toBe(401);
 expect((await post("relay.example","https://attacker.test")).status).toBe(403);
 expect((await post("attacker.test","https://relay.example")).status).toBe(403);
 }finally{await web.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});
