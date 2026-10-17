import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { windowsPowerShellEnv } from "../src/core/powershell";

it("does not pass host module paths to Windows PowerShell or mutate the host", () => {
  const source = { Path: "keep", PSModulePath: "PowerShell7", psmodulepath: "other" };
  expect(windowsPowerShellEnv(source)).toEqual({ Path: "keep" });
  expect(source.PSModulePath).toBe("PowerShell7");
});

it.skipIf(process.platform !== "win32")(
  "protects a real directory using Windows PowerShell with the host environment isolated",
  async () => {
    const root = await fs.mkdtemp(path.join(process.env.APPDATA || os.tmpdir(), "relay-acl-"));
    const actual = await fs.realpath(root);
    try {
      for (let attempt = 0; attempt < 2; attempt++) await promisify(execFile)(
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
          path.resolve("scripts/windows/protect-directory.ps1"), "-Directory", actual],
        { env: windowsPowerShellEnv(), windowsHide: true, timeout: 15000 },
      );
      await fs.writeFile(path.join(root, "probe"), "still writable by owner");
      expect(await fs.readFile(path.join(root, "probe"), "utf8")).toBe("still writable by owner");
    } finally {
      await fs.rm(actual, { recursive: true, force: true });
    }
  },
  20000,
);
