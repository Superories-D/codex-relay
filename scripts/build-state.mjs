import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function files(root,relative){
 const directory=path.join(root,relative),result=[];
 for(const item of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const name=relative+'/'+item.name;
  if(item.isDirectory())result.push(...await files(root,name));
  else if(item.isFile())result.push(name);
  else throw Error('Build inputs and products must be regular files: '+name);
 }
 return result;
}
export async function buildFingerprint(root=process.cwd()){
 const names=[...await files(root,'src'),'package.json','package-lock.json','tsconfig.json','scripts/build.mjs','scripts/build-windows-native.mjs','scripts/build-state.mjs'];
 const hash=createHash('sha256');for(const name of names.sort())hash.update(JSON.stringify([name,digest(await fs.readFile(path.join(root,name)))]));return hash.digest('hex');
}
export async function writeBuildManifest(root=process.cwd(),expectedSource){
 const source=await buildFingerprint(root);
 if(expectedSource&&source!==expectedSource)throw Error('Sources changed during build; run npm run build again');
 const products=[];for(const name of await files(root,'dist')){
  if(name==='dist/build-manifest.json')continue;
  products.push({name,sha256:digest(await fs.readFile(path.join(root,name)))});
 }
 const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 const manifest={version,source,createdAt:new Date().toISOString(),node:process.versions.node,products};
 await fs.writeFile(path.join(root,'dist/build-manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
export async function assertBuild(root=process.cwd()){
 let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(root,'dist/build-manifest.json'),'utf8'));}catch{throw Error('Build manifest unavailable; run npm run build before packaging');}
 const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 if(manifest.version!==version||manifest.source!==await buildFingerprint(root))throw Error('Compiled output is stale; run npm run build before packaging');
 const names=(await files(root,'dist')).filter(n=>n!=='dist/build-manifest.json').sort(),products=manifest.products;
 if(!Array.isArray(products)||products.length!==names.length||new Set(products.map(p=>p.name)).size!==names.length||products.some(p=>!names.includes(p.name)))throw Error('Build product inventory changed; run npm run build again');
 for(const product of products)if(digest(await fs.readFile(path.join(root,product.name)))!==product.sha256)throw Error('Build product changed: '+product.name+'; run npm run build again');
 return manifest;
}
