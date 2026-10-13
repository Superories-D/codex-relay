import { expect, it, vi } from "vitest";
import { terminateTree } from "../src/core/process";
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
