import {useEffect,useRef} from "react";
/** Retry only a persisted, identified submission. A new tab/server never adopts
 * an old unidentified intent automatically. The submitter owns acknowledgment. */
export function usePendingRetry<T extends {requestId:string;serverId?:string}>(pending:T|null,serverId:string|undefined,ready:boolean,send:(value:T)=>Promise<void>){
 const latest=useRef({pending,send});latest.current={pending,send};
 useEffect(()=>{
  if(!ready||!pending?.serverId||pending.serverId!==serverId)return;
  let cancelled=false,attempt=0,timer:ReturnType<typeof setTimeout>;
  const schedule=()=>{timer=setTimeout(async()=>{
   if(cancelled||latest.current.pending?.requestId!==pending.requestId)return;
   try{await latest.current.send(pending);}catch{/* Submitter reports failures and keeps the intent. */}
   if(!cancelled&&latest.current.pending?.requestId===pending.requestId)schedule();
  },Math.min(30000,2000*2**Math.min(attempt++,4)));};
  schedule();return()=>{cancelled=true;clearTimeout(timer);};
 },[pending?.requestId,pending?.serverId,serverId,ready]);
}
