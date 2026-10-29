import type { Job, Approval } from "../shared/types";
import {notificationEvent,notificationState} from "../shared/notification-event";
export class NotificationState {
  private states:Map<string,string>;
  private requests=new Set<string>();
  constructor(jobs:Job[]) {this.states=new Map(jobs.map(j=>[j.id,notificationEvent(j)]));}
  update(jobs:Job[],approvals:Approval[],settled?:(id:string)=>boolean) {
    const events:{id:string;kind:"completed"|"attention"|"approval"}[]=[];
    const requests=new Set<string>();
    for(const a of approvals){
      const key=JSON.stringify([a.jobId,a.id,a.historyId,a.method,a.params]); requests.add(key);
      if(!this.requests.has(key) && !events.some(e=>e.id===a.jobId)) events.push({id:a.jobId,kind:"approval"});
    }
    this.requests=requests;
    const next=new Map<string,string>();
    for(const job of jobs){
      const state=notificationState(job),event=notificationEvent(job),previous=this.states.get(job.id);
      if(state==="completed"&&settled&&!settled(job.id)){next.set(job.id,previous??event);continue;}
      next.set(job.id,event);
      if(previous && previous!==event && ["completed","needs_attention"].includes(state) && !events.some(e=>e.id===job.id)) events.push({id:job.id,kind:state==="completed"?"completed":"attention"});
    }
    this.states=next;return events;
  }
}
