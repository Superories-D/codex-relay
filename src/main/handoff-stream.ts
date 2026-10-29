import {createReadStream,promises as fs} from "node:fs";
import {TextDecoder} from "node:util";

/** Complete machine records. No UI preview or arbitrary total-byte limit. */
export async function* handoffRecords(file:string,delimiter:0|10,signal?:AbortSignal):AsyncGenerator<string>{
  let pending:Buffer[]=[],length=0;
  const decoder=new TextDecoder("utf-8",{fatal:true});
  for await(const chunk of createReadStream(file,{highWaterMark:256*1024})){
    signal?.throwIfAborted();let at=0;
    for(;;){
      const end=chunk.indexOf(delimiter,at);if(end<0)break;
      const tail=chunk.subarray(at,end),record=pending.length?Buffer.concat([...pending,tail],length+tail.length):tail;
      yield decoder.decode(record);pending=[];length=0;at=end+1;
    }
    if(at<chunk.length){const tail=Buffer.from(chunk.subarray(at));pending.push(tail);length+=tail.length;}
  }
  signal?.throwIfAborted();if(length)throw Error("交接元数据流缺少完整终止符");
}
export async function handoffWriteAll(handle:Awaited<ReturnType<typeof fs.open>>,bytes:Buffer|string){
  const data=typeof bytes==="string"?Buffer.from(bytes,"utf8"):bytes;
  let at=0;while(at<data.length){const part=await handle.write(data,at,data.length-at,null);if(!part.bytesWritten)throw Error("交接元数据无法完整写入");at+=part.bytesWritten;}
}
