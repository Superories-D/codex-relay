#!/usr/bin/env node
// Offline, read-only inspection. Never restores or starts tasks.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {parseArgs}=require('node:util');
(async()=>{
 const {values}=parseArgs({options:{'data-dir':{type:'string'}}});
 if(!values['data-dir'])throw Error('Specify --data-dir /private/relay-data');
 const results=[];
 for(const name of ['state.json','state.previous.json']){
  try{
   const file=path.join(values['data-dir'],name),stat=await fs.stat(file);
   if(!stat.isFile()||stat.size>64*1024*1024)throw Error('Invalid or oversized state file');
   const content=await fs.readFile(file),data=JSON.parse(content.toString('utf8'));
   if(data.version!==1||!Array.isArray(data.jobs)||!Array.isArray(data.accounts)||!Array.isArray(data.logs))throw Error('Unsupported state format');
   results.push({file:name,valid:true,bytes:stat.size,modifiedAt:stat.mtime.toISOString(),sha256:crypto.createHash('sha256').update(content).digest('hex'),tasks:data.jobs.length,accounts:data.accounts.length});
  }catch(e){results.push({file:name,valid:false,error:e.code==='ENOENT'?'missing':'invalid or unreadable'});}
 }
 console.log(JSON.stringify({readOnly:true,files:results},null,2));
 if(!results[0].valid)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
