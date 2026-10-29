import type { ChatAttachment } from '../shared/types';
export const draftHistoryKey='relay.composer.history.v1';
export interface DraftVersion {id:string;scope:string;text:string;files:ChatAttachment[];at:number}
export interface DraftHistory {entries:DraftVersion[];blocked:boolean;raw:string}
type Read=Pick<Storage,'getItem'>;type Write=Read&Pick<Storage,'setItem'>;
export function readDraftHistory(storage:Read):DraftHistory {
 let raw='';try{raw=storage.getItem(draftHistoryKey)||'';if(!raw)return {entries:[],blocked:false,raw};const value=JSON.parse(raw);
 if(value.version!==1||!Array.isArray(value.entries)||value.entries.length>40)throw Error();
 const entries=value.entries.map((v:any)=>{if(!v||typeof v.id!=='string'||typeof v.scope!=='string'||typeof v.text!=='string'||v.text.length>100000||!Number.isFinite(v.at)||!Array.isArray(v.files)||v.files.length>20||v.files.some((f:any)=>!f||!['mention','localImage'].includes(f.type)||typeof f.path!=='string'||typeof f.name!=='string'))throw Error();return v as DraftVersion;});
 return {entries,blocked:false,raw};}catch{return {entries:[],blocked:true,raw};}
}
export function sameDraft(a:{text:string;files:ChatAttachment[]},b:{text:string;files:ChatAttachment[]}) {return a.text===b.text&&JSON.stringify(a.files)===JSON.stringify(b.files);}
export function captureDraft(storage:Write,scope:string,text:string,files:ChatAttachment[],now=Date.now()):DraftVersion[] {
 const current=readDraftHistory(storage);if(current.blocked)throw Error('草稿历史无法读取，原记录已保留');
 if(!text.trim()&&!files.length)return current.entries;
 const last=current.entries.find(v=>v.scope===scope);if(last&&sameDraft(last,{text,files}))return current.entries;
 const entry:DraftVersion={id:crypto.randomUUID(),scope,text,files:structuredClone(files),at:now};
 const scoped=current.entries.filter(v=>v.scope===scope).slice(0,11);const others=current.entries.filter(v=>v.scope!==scope);
 const entries=[entry,...scoped,...others].sort((a,b)=>b.at-a.at).slice(0,40);
 let content=JSON.stringify({version:1,entries});while(content.length>2*1024*1024&&entries.length>1){entries.pop();content=JSON.stringify({version:1,entries});}
 if(content.length>2*1024*1024)throw Error('草稿历史空间不足，当前草稿未修改');
 storage.setItem(draftHistoryKey,content);return entries;
}
export function clearDraftHistory(storage:Write,scope:string) {const data=readDraftHistory(storage);if(data.blocked)throw Error('草稿历史无法读取，原记录已保留');storage.setItem(draftHistoryKey,JSON.stringify({version:1,entries:data.entries.filter(v=>v.scope!==scope)}));}
