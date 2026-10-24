import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { copyVerifiedArtifact } from "../src/main/vault-file";
let root: string, cwd: string, stagingRoot: string;
const bytes = Buffer.from([0, 1, 255, 200, 17, 12, 42]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-vault-file-")); cwd = path.join(root, "project"); stagingRoot = path.join(root, "staging");
  await fs.mkdir(cwd); await fs.mkdir(stagingRoot); await fs.writeFile(path.join(cwd, "artifact.bin"), bytes);
});
afterEach(async () => {vi.restoreAllMocks(); await fs.rm(root, {recursive: true, force: true});});
const copy = (extra: Partial<Parameters<typeof copyVerifiedArtifact>[0]> = {}) => copyVerifiedArtifact({cwd, relative: "artifact.bin", stagingRoot,
  output: "artifacts/产物.bin", bytes: bytes.length, sha256, ...extra});

it("copies complete binary bytes, verifies stored data and remains independent of later workspace changes", async () => {
  const progress: string[]=[];
  expect(await copy({progress: value => progress.push(value.phase)})).toMatchObject({bytes: bytes.length, sha256});
  const destination=path.join(stagingRoot,"artifacts/产物.bin");expect(await fs.readFile(destination)).toEqual(bytes);
  await fs.writeFile(path.join(cwd,"artifact.bin"),"new workspace content");expect(await fs.readFile(destination)).toEqual(bytes);
  expect(progress).toContain("copying");expect(progress).toContain("verifying");
});
it("supports a verified empty artifact without inventing content", async () => {
  await fs.writeFile(path.join(cwd,"artifact.bin"),"");
  const hash=createHash("sha256").update("").digest("hex");expect(await copy({bytes:0,sha256:hash})).toMatchObject({bytes:0,sha256:hash});
});
it("rejects an accepted fingerprint or length that no longer matches the source", async () => {
  await expect(copy({sha256:"a".repeat(64)})).rejects.toMatchObject({code:"sourceChanged"});
  await expect(copy({bytes:bytes.length+1,output:"other.bin"})).rejects.toMatchObject({code:"sourceChanged"});
  await expect(fs.stat(path.join(stagingRoot,"other.bin"))).rejects.toThrow();
});
it("does not overwrite an existing destination", async () => {
  await fs.writeFile(path.join(stagingRoot,"existing.bin"),"keep this");
  await expect(copy({output:"existing.bin"})).rejects.toMatchObject({code:"destinationError"});
  expect(await fs.readFile(path.join(stagingRoot,"existing.bin"),"utf8")).toBe("keep this");
});
it("rejects escaped source and destination paths before they can be written", async () => {
  await expect(copy({relative:"../outside"})).rejects.toMatchObject({code:"outsideWorkspace"});
  await expect(copy({output:"../outside"})).rejects.toMatchObject({code:"destinationError"});
  await expect(fs.stat(path.join(root,"outside"))).rejects.toThrow();
});
it("rejects source and destination junctions that leave their authorized roots", async () => {
  const outside=path.join(root,"outside");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"artifact.bin"),bytes);
  await fs.symlink(outside,path.join(cwd,"link"),process.platform==="win32"?"junction":"dir");
  await expect(copy({relative:"link/artifact.bin"})).rejects.toMatchObject({code:"outsideWorkspace"});
  await fs.symlink(outside,path.join(stagingRoot,"link"),process.platform==="win32"?"junction":"dir");
  await expect(copy({output:"link/forbidden.bin"})).rejects.toMatchObject({code:"destinationError"});
  expect(await fs.readdir(outside)).toEqual(["artifact.bin"]);
});
it("cancels a partial copy without changing the source or claiming a verified output", async () => {
  const data=Buffer.alloc(131072,42);await fs.writeFile(path.join(cwd,"artifact.bin"),data);const controller=new AbortController();
  await expect(copy({bytes:data.length,sha256:createHash("sha256").update(data).digest("hex"),signal:controller.signal,
    progress: value=>{if(value.phase==="copying")controller.abort();}})).rejects.toMatchObject({code:"cancelled"});
  expect(await fs.readFile(path.join(cwd,"artifact.bin"))).toEqual(data);
});
it("detects a source growing while it is copied and stops before copying unaccepted extra bytes", async () => {
  const data=Buffer.alloc(131072,42),source=path.join(cwd,"artifact.bin");await fs.writeFile(source,data);let changed=false;
  await expect(copy({bytes:data.length,sha256:createHash("sha256").update(data).digest("hex"),progress:value=>{
    if(value.phase==="copying"&&!changed){changed=true;appendFileSync(source,"late data");}
  }})).rejects.toMatchObject({code:"sourceChanged"});
  expect((await fs.stat(path.join(stagingRoot,"artifacts/产物.bin"))).size).toBeLessThanOrEqual(data.length);
});
it("handles partial writes without omitting bytes", async () => {
  const open=fs.open.bind(fs);
  vi.spyOn(fs,"open").mockImplementation(async(...args)=>{
    const file=await open(...args);if(args[1]==="wx"){
      const write=file.write.bind(file);
      file.write=((buffer:Buffer,offset:number,length:number,position:number|null)=>write(buffer,offset,Math.max(1,Math.floor(length/2)),position)) as typeof file.write;
    }return file;
  });
  expect(await copy()).toMatchObject({bytes:bytes.length,sha256});expect(await fs.readFile(path.join(stagingRoot,"artifacts/产物.bin"))).toEqual(bytes);
});
it("detects destination tampering during readback instead of accepting only the outgoing stream hash", async () => {
  const open=fs.open.bind(fs);let changed=false;
  vi.spyOn(fs,"open").mockImplementation(async(...args)=>{
    if(typeof args[1]==="number"&&String(args[0]).endsWith("产物.bin")&&!changed){changed=true;await fs.writeFile(String(args[0]),Buffer.alloc(bytes.length,99));}
    return open(...args);
  });
  await expect(copy()).rejects.toMatchObject({code:"destinationError"});
});
