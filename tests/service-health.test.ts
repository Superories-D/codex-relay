import { expect, it } from "vitest";
import { serviceHealth } from "../src/core/service-health";
import { defaults } from "../src/core/store";
it("summarizes operational backlog without exposing task or account contents", () => {
  const result = serviceHealth({ ...structuredClone(defaults), approvals: [{}], jobs: [{state:"queued",prompt:"secret",queuedMessages:[{text:"secret"}],autoRecovery:{}}],accounts:[{enabled:true,email:"secret"}] } as any);
  expect(result.tasks).toMatchObject({total:1,recovering:1,queuedMessages:1,states:{queued:1}});
  expect(result.approvals).toBe(1);
  expect(JSON.stringify(result)).not.toContain("secret");
});
