import type {Job,Snapshot} from '../shared/types';
export type InboxKind='approval'|'question'|'error'|'complete';
export interface InboxItem{id:string;signature:string;kind:InboxKind;job:Job;detail:string;at:number}
export interface InboxState{entries:Record<string,{signature:string;until:number}>}
export const inboxStorageKey='relay.attention.inbox.v1';
function requestDetail(params:unknown):string {
 if(!params||typeof params!=="object"||Array.isArray(params))return "";
 const p=params as Record<string,unknown>;
 if(typeof p.command==="string")return p.command;
 if(Array.isArray(p.command)&&p.command.every(v=>typeof v==="string"))return p.command.join(" ");
 if(typeof p.reason==="string")return p.reason;
 return "";
}

export function inboxItems(snapshot:Pick<Snapshot,'jobs'|'approvals'>):InboxItem[]{
 const items:InboxItem[]=[];
 for(const job of snapshot.jobs.filter(j=>!j.archived)){
  const requests=snapshot.approvals.filter(a=>a.jobId===job.id&&!a.responsePending);
  for(const a of requests)items.push({id:`request:${a.id}`,signature:JSON.stringify([a.id,a.historyId,a.reviewId,a.kind,a.method,a.params]),kind:a.kind==='input'?'question':'approval',job,detail:requestDetail(a.params),at:a.createdAt||job.updatedAt});
  if(job.state==='needs_attention'&&!job.autoRecovery&&!requests.length)items.push({id:`error:${job.id}`,signature:JSON.stringify([job.state,job.lastError,job.delivery?.revision,job.turnId,job.updatedAt]),kind:'error',job,detail:job.lastError||'',at:job.updatedAt});
  if(job.state==='completed')items.push({id:`complete:${job.id}`,signature:JSON.stringify([job.updatedAt,job.turnId]),kind:'complete',job,detail:'',at:job.updatedAt});
 }
 const order:Record<InboxKind,number>={approval:0,question:1,error:2,complete:3};return items.sort((a,b)=>order[a.kind]-order[b.kind]||b.at-a.at);
}
export function readInbox(storage:Pick<Storage,'getItem'>):{state:InboxState;blocked:boolean}{try{const raw=storage.getItem(inboxStorageKey);if(!raw)return {state:{entries:{}},blocked:false};const v=JSON.parse(raw);if(v.version!==1||!Array.isArray(v.entries)||v.entries.length>500||v.entries.some((e:any)=>!e||typeof e.id!=='string'||typeof e.signature!=='string'||!Number.isFinite(e.until)))throw Error();return {state:{entries:Object.fromEntries(v.entries.map((e:any)=>[e.id,{signature:e.signature,until:e.until}]))},blocked:false};}catch{return {state:{entries:{}},blocked:true};}}
export function isSnoozed(item:InboxItem,state:InboxState,now:number){const e=state.entries[item.id];return !!e&&e.signature===item.signature&&e.until>now;}
export function snoozeInbox(storage:Pick<Storage,'getItem'|'setItem'>,item:InboxItem,until:number){const data=readInbox(storage);if(data.blocked)throw Error('收件箱偏好无法读取，原记录已保留');const entries=Object.entries(data.state.entries).filter(([id])=>id!==item.id).map(([id,e])=>({id,...e}));entries.push({id:item.id,signature:item.signature,until});storage.setItem(inboxStorageKey,JSON.stringify({version:1,entries:entries.slice(-500)}));return readInbox(storage).state;}
