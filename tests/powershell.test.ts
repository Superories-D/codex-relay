import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  windowsPowerShellEnv,
  protectDataDirectory,
} from "../src/core/powershell";

it("does not pass host module paths to Windows PowerShell or mutate the host", () => {
  const source = {
    Path: "keep",
    PSModulePath: "PowerShell7",
    psmodulepath: "other",
  };
  expect(windowsPowerShellEnv(source)).toEqual({ Path: "keep" });
  expect(source.PSModulePath).toBe("PowerShell7");
});

it.skipIf(process.platform !== "win32")(
  "protects a real directory using Windows PowerShell with the host environment isolated",
  async () => {
    const fixtureParent = path.resolve("qa-output");
    await fs.mkdir(fixtureParent, { recursive: true });
    const root = await fs.mkdtemp(path.join(fixtureParent, "relay-acl-"));
    const actual = await fs.realpath(root);
    const parent = await fs.realpath(path.dirname(root));
    try {
      const script = path.resolve("scripts/windows/protect-directory.ps1");
      for (let attempt = 0; attempt < 2; attempt++)
        await protectDataDirectory(script, actual);
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const invoke = (command: string) =>
        promisify(execFile)(
          powershell,
          ["-NoProfile", "-NonInteractive", "-Command", command],
          {
            env: { ...windowsPowerShellEnv(), RELAY_TEST_DIRECTORY: actual },
            windowsHide: true,
            timeout: 15000,
          },
        );
      // A protected DACL alone must not pass the fast path: remove an extra
      // permissive ACE while retaining owner + SYSTEM and child inheritance.
      await invoke(
        `$ErrorActionPreference='Stop';$acl=[IO.Directory]::GetAccessControl($env:RELAY_TEST_DIRECTORY);$everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$rule=New-Object Security.AccessControl.FileSystemAccessRule($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($env:RELAY_TEST_DIRECTORY,$acl)`,
      );
      await protectDataDirectory(script, actual);
      const verified = JSON.parse(
        (
          await invoke(
            `$acl=[IO.Directory]::GetAccessControl($env:RELAY_TEST_DIRECTORY);@{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;inherit=[string]$_.InheritanceFlags;propagate=[string]$_.PropagationFlags;type=[string]$_.AccessControlType;inherited=$_.IsInherited}})}|ConvertTo-Json -Depth 4 -Compress`,
          )
        ).stdout,
      );
      expect(verified.protected).toBe(true);
      expect(verified.owner).toBe(verified.user);
      expect(verified.rules.map((r: any) => r.sid).sort()).toEqual(
        [verified.user, "S-1-5-18"].sort(),
      );
      for (const rule of verified.rules)
        expect(rule).toMatchObject({
          rights: "FullControl",
          inherit: "ContainerInherit, ObjectInherit",
          propagate: "None",
          type: "Allow",
          inherited: false,
        });
      await fs.writeFile(path.join(root, "probe"), "still writable by owner");
      expect(await fs.readFile(path.join(root, "probe"), "utf8")).toBe(
        "still writable by owner",
      );
    } finally {
      expect(path.dirname(actual)).toBe(parent);
      expect(path.basename(actual)).toBe(path.basename(root));
      await fs.rm(actual, { recursive: true, force: true });
    }
  },
  60000,
);

it.skipIf(process.platform !== "win32")(
  "explains an actual protection failure instead of exposing an empty Command failed dialog",
  async () => {
    await expect(
      protectDataDirectory(
        path.resolve("scripts/windows/protect-directory.ps1"),
        path.join(os.tmpdir(), `relay-missing-${process.pid}-${Date.now()}`),
      ),
    ).rejects.toThrow("无法保护数据目录");
  },
  20000,
);
