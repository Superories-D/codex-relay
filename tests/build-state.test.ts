import {it,expect} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
const {buildFingerprint,writeBuildManifest,assertBuild}=createRequire(import.meta.url)("../scripts/build-state.mjs");
it("rejects stale or replaced bundles and incomplete product inventories before packaging",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-build-state-"));
 try{
 for(const folder of ["src","scripts","dist/server","docs"])await fs.mkdir(path.join(root,folder),{recursive:true});
 const inputs={"package.json":JSON.stringify({version:"1.2.3"}),"package-lock.json":"lock","tsconfig.json":"{}","scripts/build.mjs":"build","scripts/build-windows-native.mjs":"native","scripts/build-state.mjs":"manifest","src/main.ts":"original"};
 for(const [name,value]of Object.entries(inputs))await fs.writeFile(path.join(root,name),value);
 const product=path.join(root,"dist/server/main.cjs");await fs.writeFile(product,"compiled");
 await expect(assertBuild(root)).rejects.toThrow("run npm run build");const before=await buildFingerprint(root);await writeBuildManifest(root,before);
 expect((await assertBuild(root)).version).toBe("1.2.3");await fs.writeFile(path.join(root,"docs/notes.md"),"Documentation does not change compiled code");await assertBuild(root);
 await fs.writeFile(product,"modified");await expect(assertBuild(root)).rejects.toThrow("product changed");await fs.writeFile(product,"compiled");
 await fs.writeFile(path.join(root,"dist/extra.cjs"),"unexpected");await expect(assertBuild(root)).rejects.toThrow("inventory changed");await fs.unlink(path.join(root,"dist/extra.cjs"));
 await fs.writeFile(path.join(root,"src/main.ts"),"changed");await expect(assertBuild(root)).rejects.toThrow("stale");await expect(writeBuildManifest(root,before)).rejects.toThrow("changed during build");
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
