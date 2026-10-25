import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
export async function buildWindowsNative(){
  if(process.platform!=='win32')return;
  const output=path.resolve('dist/native');await mkdir(output,{recursive:true});
  const compiler=path.join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  for(const component of ['RelayJobHost','RelayAdoptionHost'])await promisify(execFile)(compiler,['/nologo','/optimize+','/target:exe','/platform:x64','/reference:System.Runtime.Serialization.dll',`/win32manifest:${path.resolve('src/native/RelayJobHost.manifest')}`,`/out:${path.join(output,component+'.exe')}`,path.resolve('src/native/'+component+'.cs')],{windowsHide:true});
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve('scripts/build-windows-native.mjs'))await buildWindowsNative();
