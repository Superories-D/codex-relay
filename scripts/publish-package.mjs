import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
export async function publishPackage({directory,archive,output,archiveOutput,io=fs}){
 const lock=output+'.publishing',backup=output+'.previous-'+randomUUID();
 await io.mkdir(lock,{mode:0o700});let previous=false,installed=false,published=false;
 try{
  try{const stat=await io.lstat(output);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Existing package output is not a regular directory');await io.rename(output,backup);previous=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  await io.rename(directory,output);installed=true;
  await io.rename(archive,archiveOutput);published=true;
 }catch(error){
  const failures=[error];
  try{if(installed)await io.rename(output,directory);if(previous)await io.rename(backup,output);}catch(rollback){failures.push(rollback);}
  if(failures.length>1)throw new AggregateError(failures,'Package publication failed; previous output remains at '+backup);
  throw error;
 }finally{
  await io.rmdir(lock);
 }
 if(published&&previous)await io.rm(backup,{recursive:true,force:true});
}
