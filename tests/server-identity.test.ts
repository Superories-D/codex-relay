import {it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {bindServerIdentity,serverHeaders,identityChanged} from "../src/server/ui/identity";
it("pins a browser tab to one installation and preserves the pin after mismatches or storage failures",()=>{
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>{values.set(k,v);}},id=randomUUID();
 expect(()=>serverHeaders(storage)).toThrow("验证");
 expect(bindServerIdentity(id,storage)).toBe(id);expect(bindServerIdentity(id,storage)).toBe(id);
 expect(serverHeaders(storage)).toEqual({"X-Relay-Server-ID":id});
 expect(()=>bindServerIdentity(randomUUID(),storage)).toThrow(identityChanged);
 expect(serverHeaders(storage)["X-Relay-Server-ID"]).toBe(id);
 expect(()=>bindServerIdentity("not-a-uuid",storage)).toThrow("安装标识");
 expect(()=>bindServerIdentity(id,{getItem:()=>null,setItem:()=>{throw Error("storage full");}})).toThrow("storage full");
});
