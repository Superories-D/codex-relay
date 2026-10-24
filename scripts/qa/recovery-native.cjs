const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process'),{build}=require('esbuild');
(async()=>{const root=path.resolve(__dirname,'../..'),folder=await fs.mkdtemp(path.join(root,'qa-output/recovery-build-')),file=path.join(folder,'native.cjs');
await build({entryPoints:[path.join(root,'scripts/qa/recovery-native.ts')],bundle:true,platform:'node',format:'cjs',outfile:file,define:process.env.RELAY_EXECUTABLE?{'process.resourcesPath':JSON.stringify(path.join(path.dirname(process.env.RELAY_EXECUTABLE),'resources'))}:{}});
await new Promise((resolve,reject)=>{const child=cp.spawn(process.execPath,[file],{cwd:root,env:process.env,windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Recovery native QA failed: '+code)));});
})().catch(error=>{console.error(error);process.exitCode=1});
