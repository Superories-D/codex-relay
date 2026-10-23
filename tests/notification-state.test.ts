import {expect,it} from "vitest";
import {NotificationState} from "../src/core/notification-state";
it("notifies once per approval and distinguishes exhausted recovery from automatic retries",()=>{
 const job:any={id:"a",state:"running"};const n=new NotificationState([job]);
 const a:any={jobId:"a",id:"1",method:"ask",params:{question:"one"}};
 expect(n.update([job],[a])).toEqual([{id:"a",kind:"approval"}]);expect(n.update([job],[a])).toEqual([]);
 expect(n.update([job],[{...a,params:{question:"two"}}])).toHaveLength(1);
 job.state="needs_attention";job.autoRecovery={};expect(n.update([job],[])).toEqual([]);
 delete job.autoRecovery;expect(n.update([job],[])).toEqual([{id:"a",kind:"attention"}]);
 expect(n.update([job],[])).toEqual([]);
});
