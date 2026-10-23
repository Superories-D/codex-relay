import {it,expect} from "vitest";
import {conversationExport} from "../src/core/conversation-export";
it("exports paged history chronologically with credential redaction and safe fences",async()=>{
 const chats:any={read:async(_id:string,before?:number)=>before===undefined?{items:[{id:"b",role:"assistant",at:2,text:"```\nBearer abcdefghijklmnopqrstuvwxyz123456"}],before:1}:{items:[{id:"a",role:"user",at:1,text:"first"}]}};
 const result=await conversationExport(chats,{id:"task",title:"Title"} as any);
 expect(result.document.items.map(i=>i.id)).toEqual(["a","b"]);
 expect(result.markdown).toContain("````text");expect(result.markdown).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
});
it("marks bounded exports instead of silently omitting oversized history",async()=>{
 const result=await conversationExport({read:async()=>({items:[{id:"a",role:"user",at:1,text:"x".repeat(5*1024*1024)}]})} as any,{id:"a",title:"Title"} as any);
 expect(result.document.truncated).toBe(true);expect(result.markdown).toContain("Older content omitted");
});
