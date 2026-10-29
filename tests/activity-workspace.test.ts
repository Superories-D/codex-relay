import {expect,it} from "vitest";
import type {ChatItem} from "../src/shared/types";
import {activityCopyText,activityStatus,filterActivityTimeline,isToolActivity,nextFailedActivity} from "../src/renderer/activity-workspace";
const item=(id:string,kind="commandExecution",status="completed",patch:Partial<ChatItem>={}):ChatItem=>({id,kind,status,role:"tool",text:id,at:1,...patch});
it("normalizes native running/failure states without labeling reasoning or questions as executable operations",()=>{
 expect(["running","inProgress","in_progress"].map(status=>activityStatus(item("a","commandExecution",status)))).toEqual(["running","running","running"]);
 expect(activityStatus(item("failed","commandExecution","completed",{data:{failure:"Error"}}))).toBe("failed");
 expect(activityStatus(item("declined","commandExecution","declined"))).toBe("failed");
 expect(isToolActivity(item("reason","reasoning"))).toBe(false);expect(isToolActivity(item("question","questionRequest"))).toBe(false);
});
it("filters executable tools while retaining user, assistant and reasoning context in source order",()=>{
 const items=[item("user","message","",{role:"user"}),item("failed","commandExecution","failed"),item("assistant","message","",{role:"assistant"}),item("reason","reasoning"),item("file","fileChange","completed",{data:{changes:[{path:"src/Ｆｏｏ.ts"}]}})];
 expect(filterActivityTimeline(items,"failed","all","").map(i=>i.id)).toEqual(["user","failed","assistant","reason"]);
 expect(filterActivityTimeline(items,"all","files","foo").map(i=>i.id)).toEqual(["user","assistant","reason","file"]);
 expect(filterActivityTimeline(items,"running","all","absent").map(i=>i.id)).toEqual(["user","assistant","reason"]);
 expect(items).toHaveLength(5);
});
it("cycles failures in chronological order and handles a removed selection without skipping the first failure",()=>{
 const items=[item("a"),item("b","commandExecution","failed"),item("c","fileChange","declined")];
 expect(nextFailedActivity(items)?.id).toBe("b");expect(nextFailedActivity(items,"b")?.id).toBe("c");expect(nextFailedActivity(items,"c")?.id).toBe("b");expect(nextFailedActivity(items,"missing")?.id).toBe("b");expect(nextFailedActivity([item("a")])).toBeUndefined();
});
it("copies only provided operations and labels incomplete source previews without inventing full output",()=>{
 const failed=item("npm test","commandExecution","failed",{detail:"<literal> error",sourceTruncated:true});
 expect(activityCopyText([failed],"PREVIEW")).toBe("npm test\n\n<literal> error\n\n[PREVIEW]");
 expect(activityCopyText([],"PREVIEW")).toBe("");
});
