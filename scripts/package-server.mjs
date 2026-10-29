import {assertBuild} from "./build-state.mjs";
import {publishPackage} from "./publish-package.mjs";
import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const build=await assertBuild();
const pkg=JSON.parse(await fs.readFile("package.json","utf8"));
const name=`codex-relay-server-${pkg.version}-source`,release=path.resolve("release"),output=path.join(release,name);
await fs.mkdir(release,{recursive:true});
const staging=await fs.mkdtemp(path.join(release,".server-package-")),prepared=path.join(staging,name),archive=path.join(staging,name+".tar.gz");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
try{
 await fs.mkdir(prepared);
 for(const file of ["dist/server","scripts/relay.cjs","scripts/remote.cjs","scripts/remote-store.cjs","scripts/windows/protect-directory.ps1","scripts/windows/verify-private-file.ps1","scripts/inspect-state.cjs","scripts/remote-tunnel.cjs","deploy","docs/SERVER.md","docs/BACKUP.md","docs/REMOTE-CLIENT.md","docs/ITERATIONS-20261023-B.md","docs/ITERATIONS-20261027.md","docs/TELEGRAM.md","docs/TELEGRAM-CONSOLE-20261023.md","LICENSE"]){
  await fs.mkdir(path.dirname(path.join(prepared,file)),{recursive:true});await fs.cp(file,path.join(prepared,file),{recursive:true});
 }
 const products=build.products.filter(p=>p.name.startsWith("dist/server/"));
 // Validate the copied bytes too: a second build may have started during copying.
 for(const product of products)if(sha(await fs.readFile(path.join(prepared,product.name)))!==product.sha256)throw Error("Compiled server changed during packaging; rebuild and retry");
 await fs.writeFile(path.join(prepared,"BUILD.json"),JSON.stringify({...build,products},null,2));
 await fs.writeFile(path.join(prepared,"package.json"),JSON.stringify({name:"codex-relay-server",version:pkg.version,private:true,engines:{node:">=24"},scripts:{start:"node dist/server/main.cjs",check:"node dist/server/main.cjs --check"}},null,2));
 const hashes=[],copiedNames=[];
 async function walk(dir){for(const entry of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){const name=path.relative(prepared,file).split(path.sep).join("/");hashes.push(`${sha(await fs.readFile(file))}  ${name}`);copiedNames.push(name);}else throw Error("Unexpected package entry");}}
 await walk(prepared);
 const copiedServer=copiedNames.filter(name=>name.startsWith("dist/server/"));
 if(copiedServer.length!==products.length||copiedServer.some(name=>!products.some(p=>p.name===name)))throw Error("Server product inventory changed during packaging; rebuild and retry");
 await fs.writeFile(path.join(prepared,"SHA256SUMS"),hashes.join("\n")+"\n");
 execFileSync("tar",["-czf",archive,"-C",staging,name],{stdio:"inherit"});
 await publishPackage({directory:prepared,archive,output,archiveOutput:path.join(release,name+".tar.gz")});
 console.log(`Packaged ${name}: ${hashes.length} files; no accounts, tokens, runtime data or node_modules.`);
}finally{await fs.rm(staging,{recursive:true,force:true});}
