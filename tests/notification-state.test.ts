import {expect,it} from "vitest";
import {NotificationState} from "../src/core/notification-state";
import {completionAssistant} from "../src/shared/notification-event";
import {taskControlSignature} from "../src/shared/task-control";
it("waits for completion ownership to settle without making metadata controls look like another completion",()=>{
 const job:any={id:"a",state:"running"},state=new NotificationState([job]);job.state="completed";
 expect(state.update([job],[],()=>false)).toEqual([]);expect(state.update([job],[],()=>true)).toEqual([{id:"a",kind:"completed"}]);
 expect(state.update([job],[],()=>false)).toEqual([]);expect(state.update([job],[],()=>true)).toEqual([]);
});
it("bounds result summaries by completion window and turn, including legacy turnless records",()=>{
 const row=(id:string,at:number,turnId?:string):any=>({id,at,turnId,role:"assistant",text:id});
 const completion={revision:2,startedAt:20,finishedAt:30,turnId:"turn"};
 const rows=[row("old",10,"turn"),row("current",25,"turn"),row("wrong-turn",26,"other"),row("future",35,"turn")];
 expect(completionAssistant({completion},rows)?.id).toBe("current");
 expect(completionAssistant({completion},[row("old",10,"turn")])).toBeUndefined();
 expect(completionAssistant({completion},[row("legacy",25)])?.id).toBe("legacy");
 expect(completionAssistant({},rows)?.id).toBe("future");
 const job:any={state:"completed",turnId:"same",updatedAt:1,completion};const before=taskControlSignature(job);
 job.completion={...completion,revision:3};expect(taskControlSignature(job)).not.toBe(before);
});
it("distinguishes turnless completions and new failures without announcing every recovery attempt",()=>{
 const job:any={id:"a",state:"completed",completion:{revision:1,startedAt:10,finishedAt:20}};
 const n=new NotificationState([job]);job.completion.revision++;expect(n.update([job],[])).toEqual([{id:"a",kind:"completed"}]);
 job.state="needs_attention";job.lastError="First failure";expect(n.update([job],[])).toHaveLength(1);
 job.lastError="Different failure";expect(n.update([job],[])).toHaveLength(1);expect(n.update([job],[])).toEqual([]);
 job.autoRecovery={attempt:1};expect(n.update([job],[])).toEqual([]);job.autoRecovery.attempt=2;job.lastError="Retry";expect(n.update([job],[])).toEqual([]);
});
it("recognizes another completed turn even when intermediate snapshots were coalesced",()=>{
 const job:any={id:"a",state:"completed",threadId:"thread",turnId:"one",completion:{revision:1,startedAt:10,finishedAt:20,turnId:"one"}};
 const n=new NotificationState([job]);expect(n.update([job],[])).toEqual([]);
 job.title="Renamed";job.updatedAt=30;expect(n.update([job],[])).toEqual([]);
 job.turnId="two";job.completion={revision:2,startedAt:30,finishedAt:40,turnId:"two"};
 expect(n.update([job],[])).toEqual([{id:"a",kind:"completed"}]);expect(n.update([job],[])).toEqual([]);
 const restarted=new NotificationState([job]);expect(restarted.update([job],[])).toEqual([]);
});
it("notifies once per approval and distinguishes exhausted recovery from automatic retries",()=>{
 const job:any={id:"a",state:"running"};const n=new NotificationState([job]);
 const a:any={jobId:"a",id:"1",method:"ask",params:{question:"one"}};
 expect(n.update([job],[a])).toEqual([{id:"a",kind:"approval"}]);expect(n.update([job],[a])).toEqual([]);
 expect(n.update([job],[{...a,params:{question:"two"}}])).toHaveLength(1);
 job.state="needs_attention";job.autoRecovery={};expect(n.update([job],[])).toEqual([]);
 delete job.autoRecovery;expect(n.update([job],[])).toEqual([{id:"a",kind:"attention"}]);
 expect(n.update([job],[])).toEqual([]);
});
