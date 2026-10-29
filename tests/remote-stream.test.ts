import {afterEach, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import {watch} from "../src/server/ui/client";
import {bindServerIdentity} from "../src/server/ui/identity";

afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
function setup() {
  vi.useFakeTimers();
  const storage = new Map<string,string>();
  vi.stubGlobal("sessionStorage", {getItem:(key:string)=>storage.get(key) || null, setItem:(key:string,value:string)=>storage.set(key,value)});
  const id = randomUUID();
  bindServerIdentity(id);
  const frames: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const fetch = vi.fn(async (_url:unknown, init:any) => {
    const stream = new ReadableStream<Uint8Array>({start(controller) {
      frames.push(controller);
      init.signal.addEventListener("abort", () => {try{controller.error(new DOMException("Stopped", "AbortError"));}catch{}}, {once:true});
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({generation:frames.length})}\n\n`));
    }});
    return new Response(stream, {headers:{"Content-Type":"text/event-stream"}});
  });
  vi.stubGlobal("fetch", fetch);
  return {id, frames, fetch, encoder};
}
it("reconnects a silent half-open stream and keeps heartbeats alive without replaying commands", async () => {
  const f = setup(), stop = new AbortController(), snapshots:any[] = [], statuses:string[] = [];
  const running = watch("private-token", stop.signal, value=>snapshots.push(value), value=>statuses.push(value));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([{generation:1}]);
    await vi.advanceTimersByTimeAsync(30000);
    f.frames[0].enqueue(f.encoder.encode(": heartbeat\n\n"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([{generation:1},{generation:2}]);
    expect(statuses).toContain("重新连接中");
    for (const [url,init] of f.fetch.mock.calls) {
      expect(url).toBe("/api/events");
      expect(init.method).toBeUndefined();
      expect(init.headers["X-Relay-Server-ID"]).toBe(f.id);
    }
  } finally {stop.abort();await running;}
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a response that never returns headers and stops retrying on disconnection", async () => {
  const f = setup(), stop = new AbortController();
  f.fetch.mockImplementation(async (_url,init) => new Promise((_resolve,reject) => init.signal.addEventListener("abort",()=>reject(Error("No headers")), {once:true})));
  const running = watch("private-token", stop.signal, ()=>{}, ()=>{});
  await vi.advanceTimersByTimeAsync(46000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  stop.abort();
  await running;
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([401,409])("keeps authentication/identity rejection terminal and removes the heartbeat timer (HTTP %s)", async status => {
  const f=setup(), statuses:string[]=[];
  f.fetch.mockResolvedValueOnce(new Response("{}",{status}));
  await watch("private-token",new AbortController().signal,()=>{},value=>statuses.push(value));
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(statuses.at(-1)).toMatch(status===401?/令牌/:/身份/);
  expect(vi.getTimerCount()).toBe(0);
});
