import { expect, it, vi } from "vitest";
import { terminateTree } from "../src/core/process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

it("accepts a confirmed signal exit racing Windows taskkill, but rejects an unconfirmed process", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    for (const stopped of [true, false]) {
      const killer = new EventEmitter() as any;
      killer.kill = vi.fn();
      vi.mocked(spawn).mockReturnValueOnce(killer);
      const child: any = { exitCode: null, signalCode: null, pid: 123456789 };
      const stopping = terminateTree(child);
      if (stopped) child.signalCode = "SIGTERM";
      killer.emit("close", 128);
      if (stopped) await expect(stopping).resolves.toBeUndefined();
      else await expect(stopping).rejects.toThrow("无法确认");
    }
  } finally { Object.defineProperty(process, "platform", platform); }
});
it("already signal-terminated children are closed, not live processes", async () => {
  const child: any = {
    exitCode: null,
    signalCode: "SIGTERM",
    pid: 123456789,
    kill: vi.fn(),
    once: vi.fn(),
  };
  await terminateTree(child);
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.once).not.toHaveBeenCalled();
});
