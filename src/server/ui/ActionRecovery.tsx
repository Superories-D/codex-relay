import React,{useEffect,useRef,useState} from "react";
import {actionRecovery} from "./action-recovery";
import {t} from "../../renderer/i18n";

export function PendingActionRecovery({call}:{call:(name:string,args?:any)=>Promise<any>}) {
  const callRef=useRef(call);callRef.current=call;
  const [count,setCount]=useState(0);
  useEffect(()=>{
    let alive=true,running=false;
    const recovery=actionRecovery();
    const refresh=()=>{if(alive)try{setCount(recovery.keys().length);}catch{}};
    const scan=async()=>{
      if(running||!alive)return;running=true;
      try{refresh();await recovery.drain((name,args)=>callRef.current(name,args),()=>alive);}
      catch{/* Stored requests remain available for the next connection. */}
      finally{running=false;refresh();}
    };
    const unsubscribe=recovery.subscribe(refresh);void scan();const timer=setInterval(()=>void scan(),5000);
    return()=>{alive=false;clearInterval(timer);unsubscribe();};
  },[]);
  return count?<p className="remote-action-recovery" role="status">{t("正在后台确认待处理操作，切换任务不影响恢复。")} · {count}</p>:null;
}
