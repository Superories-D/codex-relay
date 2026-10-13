import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { recoverJob } from "../src/core/recovery";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-recovery-"));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));
describe("crash recovery refuses duplicate writers", () => {
  it("marks interrupted persisted jobs for global recovery gating", async () => {
    const s = new Store(root);
    s.data.jobs = [{ id: "a", state: "running" } as any];
    await s.save();
    const restored = new Store(root);
    await restored.load();
    expect(restored.data.jobs[0]).toMatchObject({
      state: "needs_attention",
      recoveryRequired: true,
    });
  });
  it("refuses a still-live owner instead of deleting its lock", async () => {
    const file = path.join(root, "relay-owner.json");
    await fs.writeFile(
      file,
      JSON.stringify({ pid: process.pid, nonce: "test" }),
    );
    await expect(Rpc.assertHomeIdle(root)).rejects.toThrow("重复实例");
    expect(await fs.readFile(file, "utf8")).toContain("test");
  });
  it("refuses a malformed owner record", async () => {
    await fs.writeFile(path.join(root, "relay-owner.json"), "{bad");
    await expect(Rpc.assertHomeIdle(root)).rejects.toThrow("损坏");
  });
  it("preserves credentials when the desktop receipt is missing", async () => {
    const s = new Store(root);
    const home = s.jobHome("job");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "desktop-launch.json"),
      JSON.stringify({ nonce: "own" }),
    );
    await fs.writeFile(path.join(home, "auth.json"), "preserve");
    await expect(
      recoverJob({ id: "job", mode: "desktop" } as any, s, {} as any, root),
    ).rejects.toThrow("回执");
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(
      "preserve",
    );
  });
});
