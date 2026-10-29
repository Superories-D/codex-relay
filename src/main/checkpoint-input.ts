import type {Writable} from "node:stream";
import {finished} from "node:stream/promises";

/** Transfer every byte before treating a successful consumer exit as EOF. */
export async function writeCheckpointInput(destination:Writable,input:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,closed:Promise<number|null>) {
  // A consumer may exit while the source is doing its final EOF read. Keep the
  // stream error observed even when no write callback is currently outstanding.
  const observe=()=>{};
  destination.on("error",observe);
  try {
    for await(const chunk of input) {
      if(!chunk.length)continue;
      await new Promise<void>((resolve,reject)=>destination.write(chunk,error=>error?reject(error):resolve()));
    }
    // index-pack knows the pack length and can exit without waiting for EOF.
    // Only this final handshake may be superseded by a successful process exit;
    // source reads and every data write above must have completed successfully.
    try {
      if(destination.destroyed)throw destination.errored||Object.assign(Error("Git 输入流在 EOF 确认前关闭"),{code:"ERR_STREAM_PREMATURE_CLOSE"});
      destination.end();
      await finished(destination,{readable:false,cleanup:true});
    }
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      if(!["ERR_STREAM_PREMATURE_CLOSE","ERR_STREAM_DESTROYED","EPIPE"].includes(code||"")||await closed!==0)throw error;
    }
  } finally {destination.removeListener("error",observe);}
}
