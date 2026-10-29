import {it,expect,vi} from "vitest";
import {RefreshQueue} from "../src/shared/refresh-queue";
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

it("coalesces slow polling reads without starving the current result",async()=>{
  const pending=deferred<number>(),values:number[]=[],load=vi.fn(()=>pending.promise),busy:boolean[]=[];
  const queue=new RefreshQueue(load,value=>values.push(value),()=>{},value=>busy.push(value));
  queue.refresh();queue.refresh();queue.refresh();expect(load).toHaveBeenCalledTimes(1);
  pending.resolve(1);await flush();expect(values).toEqual([1]);expect(load).toHaveBeenCalledTimes(1);expect(busy.at(-1)).toBe(false);queue.dispose();
});
it.each([false,true])("discards an old response after mutation and queues one fresh read (old error=%s)",async error=>{
  const first=deferred<string>(),second=deferred<string>(),values:string[]=[],errors:unknown[]=[];
  const load=vi.fn<()=>Promise<string>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const queue=new RefreshQueue(load,value=>values.push(value),error=>errors.push(error));
  queue.refresh();queue.invalidate();queue.invalidate();queue.refresh();expect(load).toHaveBeenCalledTimes(1);
  if(error)first.reject(Error("Stale failure"));else first.resolve("Stale data");
  await flush();expect(load).toHaveBeenCalledTimes(2);expect(values).toEqual([]);expect(errors).toEqual([]);
  second.resolve("Committed data");await flush();expect(values).toEqual(["Committed data"]);queue.dispose();
});
it("drops queued work and callbacks when its owner closes",async()=>{
  const pending=deferred<string>(),value=vi.fn(),error=vi.fn(),load=vi.fn((_signal:AbortSignal)=>pending.promise);
  const queue=new RefreshQueue(load,value,error);queue.refresh();queue.invalidate();queue.dispose();pending.reject(Error("Closed"));await flush();
  expect(load).toHaveBeenCalledTimes(1);expect(value).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
  expect(load.mock.calls[0][0].aborted).toBe(true);
});
it("permits a later refresh after a failed read",async()=>{
  const load=vi.fn<()=>Promise<string>>().mockRejectedValueOnce(Error("Offline")).mockResolvedValueOnce("Recovered"),values:string[]=[],errors:unknown[]=[];
  const queue=new RefreshQueue(load,value=>values.push(value),error=>errors.push(error));queue.refresh();await flush();expect(errors).toHaveLength(1);
  queue.refresh();await flush();expect(values).toEqual(["Recovered"]);queue.dispose();
});
