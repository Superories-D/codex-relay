import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {promises as fs,createReadStream,createWriteStream} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {pipeline} from "node:stream/promises";
import {TextDecoder} from "node:util";
import {PassThrough,type Readable,type Writable} from "node:stream";
import os from "node:os";
import {resolveCli,terminateTree} from "../core/process";
import {spawnWindowsDomain,releaseWindowsDomain,type DomainChild} from "../core/windows-domain";
import {writeCheckpointInput} from "./checkpoint-input";

export class CheckpointGitError extends Error {constructor(readonly args:string[],readonly code:number|null,readonly details:string){super(`Git 检查点操作未完成：${details||code}`);}}
export class CheckpointGit {
  readonly scratch:string;
  constructor(scratch:string,private options:{signal?:AbortSignal;native?:boolean}={}){this.scratch=path.resolve(scratch);}
  async run(cwd:string,args:string[],options:{input?:string;stdinFile?:string;produceInput?:(stream:Writable)=>Promise<void>;output?:string;consumeOutput?:(stream:Readable)=>Promise<void>;env?:NodeJS.ProcessEnv;metadataLimit?:number;resolveOutputPath?:boolean}={}):Promise<Buffer>{
    cwd=path.resolve(cwd);
    if(options.output&&options.consumeOutput)throw Error("Git 输出只能使用一个完整接收目标");
    if(options.produceInput&&(options.stdinFile||options.input!==undefined))throw Error("Git 输入只能使用一个完整提供来源");
    this.options.signal?.throwIfAborted();await fs.mkdir(this.scratch,{recursive:true,mode:0o700});
    // Windows CreateProcess still bounds its cwd even when file I/O supports
    // long paths. Git receives the full repository path through -C; only its
    // per-command process home uses a short private temporary directory.
    const windows=process.platform==="win32",native=windows&&this.options.native!==false,homeParent=windows?await fs.realpath(os.tmpdir()):await fs.realpath(this.scratch),home=await fs.mkdtemp(path.join(homeParent,windows?"relay-checkpoint-git-":"git-")),claim=randomUUID();
    await fs.writeFile(path.join(home,".relay-checkpoint-git.json"),JSON.stringify({version:1,claim}),{flag:"wx",mode:0o600});
    if(native)await fs.writeFile(path.join(this.scratch,`domain-${claim}.json`),JSON.stringify({home,claim}),{flag:"wx",mode:0o600});
    const resolved=await resolveCli("git"),hooks=path.join(home,"empty-hooks");await fs.mkdir(hooks);
    const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|TEMPLATE_DIR)$/i.test(key)&&key.toUpperCase()!=="OPENAI_API_KEY"));
    Object.assign(env,{GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",GIT_NO_LAZY_FETCH:"1",...options.env});
    // Git for Windows bounds GIT_DIR itself even when core.longpaths is enabled.
    // Give this command short, owned aliases to the complete existing paths.
    // The index remains the independent copy; source metadata is never moved.
    const aliases:{file:string;target:string}[]=[];
    const aliasDirectory=async(directory:string)=>{const target=await fs.realpath(directory),stat=await fs.lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("Git 检查目录归属已变化");const alias=path.join(home,`path-${aliases.length}`);await fs.symlink(target,alias,"junction");aliases.push({file:alias,target});return alias;};
    const processCwd=windows&&Buffer.byteLength(cwd,"utf8")>200?await aliasDirectory(cwd):cwd;
    if(windows)for(const name of ["GIT_DIR","GIT_WORK_TREE","GIT_OBJECT_DIRECTORY","GIT_INDEX_FILE"]){
      // Git's explicit-GIT_DIR check reserves another 40 bytes from PATH_MAX.
      const value=env[name];if(!value||!path.isAbsolute(value)||Buffer.byteLength(value,"utf8")<=200)continue;
      const alias=await aliasDirectory(name==="GIT_INDEX_FILE"?path.dirname(value):value);env[name]=name==="GIT_INDEX_FILE"?path.join(alias,path.basename(value)):alias;
    }
    // Git processes -C immediately. Enable its Windows long-path handling first.
    const argv=[...resolved.prefix,"-c","core.longpaths=true","-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false","-c","maintenance.auto=false","-c","gc.auto=0","-C",processCwd,...args];
    let child:ChildProcessWithoutNullStreams;
    if(native)child=await spawnWindowsDomain(resolved.executable,argv,home,env);
    else child=spawn(resolved.executable,argv,{env,cwd:home,windowsHide:true,shell:false,stdio:["pipe","pipe","pipe"]});
    const chunks:Buffer[]=[],limit=options.metadataLimit??1024*1024;let size=0,stderr="",ioError:unknown,stop:Promise<void>|undefined,operationError:unknown;
    const stopping=()=>{stop??=terminateTree(child);void stop.catch(()=>{});};
    this.options.signal?.addEventListener("abort",stopping,{once:true});if(this.options.signal?.aborted)stopping();
    child.stderr.on("data",data=>{stderr=(stderr+data.toString()).slice(-16000);});
    const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);if(child.exitCode!==null)resolve(child.exitCode);});
    const output=options.consumeOutput?(()=>{
      // ChildProcess drains unconsumed stdio on exit. Own stdout immediately:
      // consumers may await filesystem ownership checks before their first read.
      // The relay retains a bounded window and backpressures larger output.
      const buffered=new PassThrough({highWaterMark:256*1024});
      const transferred=pipeline(child.stdout,buffered);
      const consumed=Promise.resolve().then(()=>options.consumeOutput!(buffered)).then(()=>{if(!buffered.readableEnded)throw Error("Git 输出接收器未读取完整数据");}).catch(error=>{buffered.destroy(error instanceof Error?error:Error(String(error)));throw error;});
      return Promise.all([transferred,consumed]).then(()=>{});
    })():options.output?pipeline(child.stdout,createWriteStream(options.output,{flags:"wx",mode:0o600})):(async()=>{for await(const chunk of child.stdout){size+=chunk.length;if(size>limit)throw Error("检查点元数据过大，请使用完整流式读取");chunks.push(Buffer.from(chunk));}})();
    if(options.produceInput)child.stdin.on("error",error=>{ioError=error;});
    const input=options.produceInput?Promise.resolve().then(()=>options.produceInput!(child.stdin)):writeCheckpointInput(child.stdin,options.stdinFile?createReadStream(options.stdinFile):[Buffer.from(options.input??"")],closed);
    try{
      const outcomes=await Promise.allSettled([output.catch(error=>{ioError=error;stopping();throw error;}),input.catch(error=>{ioError=error;stopping();throw error;}),closed]);
      await stop;this.options.signal?.throwIfAborted();
      // A failed command can close stdin before the final EOF handshake. Keep
      // its exit status instead of replacing it with a secondary pipe error.
      // Source/read failures and undelivered bytes on a successful exit still fail.
      const exited=outcomes[2].status==="fulfilled"?outcomes[2].value:null;
      if(exited!==null&&exited!==0&&["ERR_STREAM_PREMATURE_CLOSE","ERR_STREAM_DESTROYED","EPIPE"].includes((ioError as NodeJS.ErrnoException)?.code||""))
        throw new CheckpointGitError(args,exited,stderr.trim());
      if(ioError)throw ioError;
      for(const result of outcomes)if(result.status==="rejected")throw result.reason;
      const code=(outcomes[2] as PromiseFulfilledResult<number|null>).value;if(code!==0)throw new CheckpointGitError(args,code,stderr.trim());
      if(options.output){const file=await fs.open(options.output,"r+");try{await file.sync();}finally{await file.close();}}
      const bytes=Buffer.concat(chunks);if(options.resolveOutputPath){const value=bytes.toString("utf8").trim();if(path.isAbsolute(value))for(const alias of aliases){const relative=path.relative(alias.file,value);if(!relative||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative))return Buffer.from(path.join(alias.target,relative));}}return bytes;
    }catch(error){operationError=error;throw error;}finally{
      this.options.signal?.removeEventListener("abort",stopping);
      const domain=(child as DomainChild).relayDomain;
      if(domain)try{await releaseWindowsDomain(domain.owner.home,domain.owner.nonce);}catch(error){throw operationError?new AggregateError([operationError,error],`${operationError instanceof Error?operationError.message:String(operationError)}; Windows 进程归属回执未能释放`):error;}
      if(windows){const physical=await fs.realpath(home),marker=JSON.parse(await fs.readFile(path.join(physical,".relay-checkpoint-git.json"),"utf8"));if(path.dirname(physical)!==homeParent||!path.basename(physical).startsWith("relay-checkpoint-git-")||(await fs.lstat(home)).isSymbolicLink()||marker.claim!==claim)throw Error("Git 临时进程目录归属已变化");for(const alias of aliases){if(path.dirname(alias.file)!==physical||!(await fs.lstat(alias.file)).isSymbolicLink()||path.resolve(await fs.realpath(alias.file)).toLowerCase()!==path.resolve(alias.target).toLowerCase())throw Error("Git 检查目录归属已变化");await fs.unlink(alias.file);}await fs.rm(physical,{recursive:true,force:true});}
    }
  }
  async text(cwd:string,args:string[],env?:NodeJS.ProcessEnv){const resolveOutputPath=args[0]==="rev-parse"&&args.some(value=>["--show-toplevel","--absolute-git-dir","--git-common-dir","--git-path","--shared-index-path"].includes(value));return (await this.run(cwd,args,{env,resolveOutputPath})).toString("utf8").trim();}
  async records(cwd:string,args:string[],env?:NodeJS.ProcessEnv,options:{input?:string;allowCode?:number}={}){
    const file=path.join(this.scratch,`records-${randomUUID()}`);try{await this.run(cwd,args,{env,output:file,input:options.input});}catch(error){if(!(error instanceof CheckpointGitError)||error.code!==options.allowCode)throw error;}const records:string[]=[];let pending=Buffer.alloc(0);const decoder=new TextDecoder("utf-8",{fatal:true});
    for await(const chunk of createReadStream(file)){this.options.signal?.throwIfAborted();pending=Buffer.concat([pending,chunk]);let offset:number;
      while((offset=pending.indexOf(0))>=0){records.push(decoder.decode(pending.subarray(0,offset)));pending=pending.subarray(offset+1);}}
    if(pending.length)throw Error("Git 元数据流缺少完整终止符");return records.filter(Boolean);
  }
  async indexFlags(cwd:string,env?:NodeJS.ProcessEnv){
    const file=path.join(this.scratch,`flags-${randomUUID()}`);await this.run(cwd,["ls-files","--debug","-z"],{env,output:file});
    const result:{path:string;bits:string}[]=[],decoder=new TextDecoder("utf-8",{fatal:true});let pending=Buffer.alloc(0),name:string|undefined;
    for await(const chunk of createReadStream(file)){pending=Buffer.concat([pending,chunk]);
      for(;;){if(name===undefined){const end=pending.indexOf(0);if(end<0)break;name=decoder.decode(pending.subarray(0,end));pending=pending.subarray(end+1);}
        const match=/^([\s\S]*?\bflags: ([a-f0-9]+)\r?\n)/.exec(pending.toString("utf8"));if(!match)break;
        result.push({path:name,bits:(BigInt(`0x${match[2]}`)&0x60008000n).toString(16)});pending=pending.subarray(Buffer.byteLength(match[1]));name=undefined;
      }
    }
    if(pending.length||name!==undefined)throw Error("Git 暂存区标志流不完整");return result;
  }
}
