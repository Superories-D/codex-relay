import {expect,it} from 'vitest';
import {inboxItems,isSnoozed,readInbox,snoozeInbox,inboxStorageKey} from '../src/renderer/attention-inbox';
import type {Job,Snapshot} from '../src/shared/types';
const job=(id:string,state:Job['state'],extra:Partial<Job>={})=>({id,state,updatedAt:10,...extra} as Job);
const storage=()=>{const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)||null,setItem:(k:string,v:string)=>{m.set(k,v);}};};
it('prioritizes requests and hides resolved/archived/automatic recovery without mutating authority',()=>{const j=job('a','running'),snap={jobs:[j,job('b','needs_attention',{autoRecovery:{} as any}),job('c','completed'),job('d','completed',{archived:true})],approvals:[{id:'r',jobId:'a',kind:'input',method:'input'}]} as Snapshot;expect(inboxItems(snap).map(i=>i.kind)).toEqual(['question','complete']);expect(j.state).toBe('running');});
it('expires snoozes and invalidates them on a changed request or new completion',()=>{const s=storage(),item=inboxItems({jobs:[job('a','completed')],approvals:[]})[0];const state=snoozeInbox(s,item,100);expect(isSnoozed(item,state,99)).toBe(true);expect(isSnoozed(item,state,100)).toBe(false);expect(isSnoozed({...item,signature:'new turn'},state,1)).toBe(false);expect(readInbox(s).blocked).toBe(false);});
it('keeps corrupt preferences intact and leaves state unchanged when saving fails',()=>{const s=storage(),item=inboxItems({jobs:[job('a','completed')],approvals:[]})[0];s.setItem(inboxStorageKey,'bad');expect(()=>snoozeInbox(s,item,100)).toThrow();expect(s.getItem(inboxStorageKey)).toBe('bad');});
it('reopens a revised approval and a later repeated error instead of inheriting older reminders',()=>{
 const request={id:'r',jobId:'a',kind:'command',method:'exec',reviewId:'v1',params:{command:'first'}};
 const first=inboxItems({jobs:[job('a','running')],approvals:[request as any]})[0];expect(first.detail).toBe('first');const s=storage(),state=snoozeInbox(s,first,1000);
 const revised=inboxItems({jobs:[job('a','running')],approvals:[{...request,reviewId:'v2'} as any]})[0];
 expect(isSnoozed(revised,state,1)).toBe(false);
 const error=inboxItems({jobs:[job('e','needs_attention',{turnId:'one',lastError:'same'})],approvals:[]})[0];
 const errors=snoozeInbox(s,error,1000);const next=inboxItems({jobs:[job('e','needs_attention',{turnId:'two',lastError:'same'})],approvals:[]})[0];expect(isSnoozed(next,errors,1)).toBe(false);
});
