import {afterEach,beforeEach,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Desktop} from '../src/core/desktop';
let root:string,desktop:Desktop;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-editor-conflict-'));desktop=new Desktop(path.join(root,'profile'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it('rejects same-size same-timestamp replacements by content fingerprint and preserves disk bytes',async()=>{
 const file=path.join(root,'file.txt');await fs.writeFile(file,'first');
 await fs.utimes(file,new Date(1000000),new Date(1000000));
 const preview=await desktop.read(root,'file.txt');expect(preview.kind).toBe('text');
 await fs.writeFile(file,'other');await fs.utimes(file,new Date(1000000),new Date(1000000));
 const changed=await desktop.read(root,'file.txt');expect(changed.mtime).toBe(preview.mtime);
 await expect(desktop.write(root,'file.txt','draft',preview.mtime,(preview as any).sha256)).rejects.toThrow('已被其他程序修改');
 expect(await fs.readFile(file,'utf8')).toBe('other');
 await desktop.write(root,'file.txt','reviewed',(changed as any).mtime,(changed as any).sha256);expect(await fs.readFile(file,'utf8')).toBe('reviewed');
});
it('serializes writes to the same canonical file and refuses the stale concurrent writer',async()=>{
 await fs.writeFile(path.join(root,'file.txt'),'before');const preview=await desktop.read(root,'file.txt');
 const outcomes=await Promise.allSettled([desktop.write(root,'file.txt','first',preview.mtime,(preview as any).sha256),desktop.write(root,'./file.txt','second',preview.mtime,(preview as any).sha256)]);
 expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(value=>value.status==='rejected')).toHaveLength(1);const winner=outcomes.findIndex(value=>value.status==='fulfilled');expect(await fs.readFile(path.join(root,'file.txt'),'utf8')).toBe(winner===0?'first':'second');
});
it('checks UTF-8 byte limits before saving and still rejects escape paths',async()=>{
 await fs.writeFile(path.join(root,'file.txt'),'before');const preview=await desktop.read(root,'file.txt');
 await expect(desktop.write(root,'file.txt','界'.repeat(800000),preview.mtime,(preview as any).sha256)).rejects.toThrow('2 MB');
 expect(await fs.readFile(path.join(root,'file.txt'),'utf8')).toBe('before');
 await expect(desktop.write(root,'../outside.txt','escape',preview.mtime,(preview as any).sha256)).rejects.toThrow();
});
