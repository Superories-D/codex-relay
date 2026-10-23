import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const pkg=JSON.parse(await fs.readFile("package.json","utf8"));
const name=`codex-relay-server-${pkg.version}-source`,output=path.resolve("release",name);
await fs.mkdir("release",{recursive:true});
await fs.rm(output,{recursive:true,force:true});await fs.mkdir(output,{recursive:true});
for(const file of ["dist/server","scripts/relay.cjs","scripts/remote.cjs","scripts/remote-tunnel.cjs","deploy","docs/SERVER.md","docs/TELEGRAM.md","LICENSE"]){
 await fs.mkdir(path.dirname(path.join(output,file)),{recursive:true});await fs.cp(file,path.join(output,file),{recursive:true});
}
await fs.writeFile(path.join(output,"package.json"),JSON.stringify({name:"codex-relay-server",version:pkg.version,private:true,engines:{node:">=24"},scripts:{start:"node dist/server/main.cjs",check:"node dist/server/main.cjs --check"}},null,2));
const hashes=[];
async function walk(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())hashes.push(`${createHash("sha256").update(await fs.readFile(file)).digest("hex")}  ${path.relative(output,file).split(path.sep).join("/")}`);else throw Error("Unexpected package entry");}}
await walk(output);await fs.writeFile(path.join(output,"SHA256SUMS"),hashes.join("\n")+"\n");
execFileSync("tar",["-czf",path.resolve("release",`${name}.tar.gz`),"-C",path.resolve("release"),name],{stdio:"inherit"});
console.log(`Packaged ${name}: ${hashes.length} files; no accounts, tokens, runtime data or node_modules.`);
