#!/usr/bin/env node
const {spawn}=require('node:child_process');
const {parseArgs}=require('node:util');
function tunnelArguments(values){
 const host=values.host;
 if(typeof host!=='string'||! /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)||host.length>253)throw Error('Use --host user@hostname (no shell options or URLs)');
 const port=(value,fallback)=>{const n=value===undefined?fallback:Number(value);if(!/^\d+$/.test(String(value??fallback))||!Number.isInteger(n)||n<1||n>65535)throw Error('Ports must be integers from 1 to 65535');return n;};
 const local=port(values['local-port'],7899),remote=port(values['remote-port'],7899),ssh=port(values['ssh-port'],22);
 return {local,args:['-N','-T','-p',String(ssh),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-L',`127.0.0.1:${local}:127.0.0.1:${remote}`,'--',host]};
}
async function main(){
 const {values}=parseArgs({options:{host:{type:'string'},'local-port':{type:'string'},'remote-port':{type:'string'},'ssh-port':{type:'string'},check:{type:'boolean'},help:{type:'boolean'}}});
 if(values.help){console.log('Relay SSH tunnel: node remote-tunnel.cjs --host user@server [--local-port 7899] [--remote-port 7899] [--ssh-port 22]\nRequires OpenSSH and a previously verified host key. --check validates arguments without connecting.\nUse the printed local URL with the server HTTP token. Ctrl+C closes the tunnel; server tasks keep running.');return;}
 const {local,args}=tunnelArguments(values);
 if(values.check){console.log(JSON.stringify({executable:'ssh',args,localUrl:`http://127.0.0.1:${local}`},null,2));return;}
 const child=spawn('ssh',args,{stdio:'inherit',shell:false,windowsHide:true});
 const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
 child.once('error',e=>{console.error(`Cannot start OpenSSH: ${e.code||'unknown error'}`);process.exitCode=1;});
 child.once('exit',(code,signal)=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.exitCode=code??(signal?130:1);});
 child.once('spawn',()=>console.log(`SSH is connecting. After authentication, open http://127.0.0.1:${local}\nKeep this window open. Host-key verification is required; no HTTP token is sent through command arguments.`));
}
module.exports={tunnelArguments};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
