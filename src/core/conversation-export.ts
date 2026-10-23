import type { Chats } from "./chat";
import type { Job, ChatItem } from "../shared/types";
import { redactValue } from "./redact";
const fence=(text:string)=>"`".repeat(Math.max(3,...(text.match(/`+/g)||[]).map(s=>s.length+1)));
export async function conversationExport(chats:Chats,job:Job) {
  const items=new Map<string,ChatItem>();let before:number|undefined,bytes=0,truncated=false;
  const cursors=new Set<number>();
  do {
    const page=await chats.read(job.id,before);
    for(const item of [...page.items].reverse()) {
      if(items.has(item.id)) continue;
      const row=redactValue({id:item.id,role:item.role,at:item.at,text:item.text,detail:item.detail}) as ChatItem;
      const size=Buffer.byteLength(JSON.stringify(row));
      if(items.size>=5000 || bytes+size>4*1024*1024){truncated=true;break;}
      bytes+=size;items.set(row.id,row);
    }
    if(truncated)break;
    before=page.before;
    if(before!==undefined){if(cursors.has(before))throw Error("Conversation pagination did not advance");cursors.add(before);}
  } while(before!==undefined);
  const rows=[...items.values()].reverse();
  const title=String(redactValue(job.title));
  const document={version:1,jobId:job.id,title,exportedAt:Date.now(),truncated,items:rows};
  const markdown=`# ${title.replace(/[\r\n]/g," ")}\n\n`+(truncated?"> Export limited to the newest 5,000 messages / 4 MiB. Older content omitted.\n\n":"")+rows.map(row=>{
    const text=[row.text,row.detail].filter(Boolean).join("\n\n"),f=fence(text);
    return `## ${row.role} · ${new Date(row.at).toISOString()}\n\n${f}text\n${text}\n${f}\n`;
  }).join("\n");
  return {document,markdown};
}
