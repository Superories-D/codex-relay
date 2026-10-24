import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {Store} from "../src/core/store";
import {RecoveryDomains,type ScopeEvidence} from "../src/core/recovery-domains";
import type {Job} from "../src/shared/types";
let root:string,store:Store,owner:Job,candidate:Job;
const evidence=():ScopeEvidence=>({status:"scoped",reason:"contained",accounts:["reserved"],paths:[owner.cwd],processes:2});
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-domains-"));const a=path.join(root,"a"),b=path.join(root,"b");await fs.mkdir(a);await fs.mkdir(b);store=new Store(path.join(root,"data"));
owner={id:"owner",title:"Held task",cwd:a,accountId:"reserved",mode:"cli",state:"needs_attention",recoveryRequired:true,sandbox:"workspaceWrite"} as Job;
candidate={id:"candidate",title:"Independent task",cwd:b,mode:"cli",state:"queued",sandbox:"workspaceWrite"} as Job;store.data.jobs=[owner,candidate];});
afterEach(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(os.tmpdir());if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("relay-domains-"))throw Error("Unsafe recovery fixture cleanup");await fs.rm(actual,{recursive:true,force:true});});
it("does not trust a persisted observation before fresh inspection, then reserves only proven resources",async()=>{
  owner.recoveryDomainObservation={signature:"old",status:"scoped",reason:"contained",at:1};
  const domains=new RecoveryDomains(store,async()=>evidence());expect(domains.blockers(candidate,[])).toEqual([owner.id]);
  await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([]);expect([...domains.blockedAccounts([])]).toEqual(["reserved"]);
  expect(domains.blockers(owner,[])).toEqual([owner.id]);const disk=JSON.parse(await fs.readFile(path.join(store.root,"state.json"),"utf8"));expect(disk.jobs[0].recoveryDomainObservation.status).toBe("scoped");
});
it("holds canonical project aliases, nested workspaces, shared families and Desktop candidates",async()=>{
  const alias=path.join(root,"alias");await fs.symlink(owner.cwd,alias,process.platform==="win32"?"junction":"dir");candidate.cwd=alias;
  const domains=new RecoveryDomains(store,async()=>evidence());await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([owner.id]);
  candidate.cwd=path.join(root,"b");candidate.runtimeHomeId=owner.id;await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([owner.id]);
  candidate.runtimeHomeId=undefined;candidate.cwd=path.join(owner.cwd,"nested");await fs.mkdir(candidate.cwd);await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([owner.id]);
  candidate.cwd=path.join(root,"b");candidate.mode="desktop";await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([owner.id]);
});
it("invalidates a scope immediately when its resource binding changes",async()=>{
  const domains=new RecoveryDomains(store,async()=>evidence());await domains.refresh([]);expect(domains.global([])).toEqual([]);
  owner.accountId="different";expect(domains.global([])).toEqual([owner.id]);expect(domains.blockers(candidate,[])).toEqual([owner.id]);
});
it("rejects evidence whose binding changed during an asynchronous inspection",async()=>{
  const domains=new RecoveryDomains(store,async()=>{const result=evidence();owner.projectCwd=candidate.cwd;return result;});await domains.refresh([]);
  expect(domains.global([])).toEqual([owner.id]);expect(domains.view([])[0].reason).toBe("changedResources");
});
it("keeps the gate global until the evidence is durably saved and allows a later explicit retry",async()=>{
  const domains=new RecoveryDomains(store,async()=>evidence()),save=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk denied"));await domains.refresh([]);
  expect(domains.blockers(candidate,[])).toEqual([owner.id]);expect(domains.view([])[0].reason).toBe("storage");expect(owner.recoveryDomainObservation).toBeUndefined();
  save.mockRestore();await domains.refresh([]);expect(domains.blockers(candidate,[])).toEqual([]);expect(owner.recoveryDomainObservation?.status).toBe("scoped");
});
it("keeps a recovery owner missing from the task list global even alongside valid scoped evidence",async()=>{
  const domains=new RecoveryDomains(store,async()=>evidence());await domains.refresh(["removed-owner"]);
  expect(domains.global(["removed-owner"])).toEqual(["removed-owner"]);expect(domains.blockers(candidate,["removed-owner"])).toEqual(["removed-owner"]);
});
