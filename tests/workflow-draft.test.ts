import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {parseWorkflowDraft} from "../src/renderer/workflow-draft";
it("restores the original submission identity and rejects corrupt or oversized drafts",()=>{
 const d={requestId:randomUUID(),title:"Pipeline",directory:"/project",model:"",submitted:true,steps:[{id:randomUUID(),text:"a"},{id:randomUUID(),text:"b"}]};
 expect(parseWorkflowDraft(JSON.stringify(d))).toEqual(d);
 expect(parseWorkflowDraft(JSON.stringify({...d,steps:[d.steps[0],d.steps[0]]}))).toBeUndefined();
 expect(parseWorkflowDraft("null")).toBeUndefined();expect(parseWorkflowDraft("{")).toBeUndefined();
});
