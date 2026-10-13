import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWindowsSandbox } from "../src/core/windows-sandbox";
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.useRealTimers();
});
function rpc(success = true) {
  Object.defineProperty(process, "platform", { value: "win32" });
  const r = new EventEmitter() as any;
  r.call = vi.fn(async (method: string) => {
    if (method === "windowsSandbox/readiness")
      return { status: "notConfigured" };
    if (method === "windowsSandbox/setupStart")
      r.emit("windowsSandbox/setupCompleted", {
        success,
        error: success ? undefined : "setup failed",
      });
    return {};
  });
  return r;
}
describe("official Windows sandbox setup", () => {
  it("handles completion arriving before setup acknowledgement", async () => {
    const r = rpc();
    await ensureWindowsSandbox(r, "C:\\work", "workspaceWrite");
    expect(r.call).toHaveBeenCalledWith("windowsSandbox/setupStart", {
      mode: "unelevated",
      cwd: "C:\\work",
    });
    expect(r.listenerCount("windowsSandbox/setupCompleted")).toBe(0);
  });
  it("never silently downgrades permissions when setup fails", async () => {
    const r = rpc(false);
    await expect(
      ensureWindowsSandbox(r, "C:\\work", "workspaceWrite"),
    ).rejects.toThrow("setup failed");
  });
});
