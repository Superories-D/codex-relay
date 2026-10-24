import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ServerRuntime } from "../src/server/runtime";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  backupPassword,
} from "../src/server/backup";
import { ServerCipher } from "../src/server/vault";
it.skipIf(process.platform !== "linux")(
  "encrypts offline state, authenticates before publication and restores credentials/uploads at the original path",
  async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-backup-")),
      root = path.join(base, "data"),
      archive = path.join(base, "backup.crb"),
      password = "a unique long backup password";
    let runtime: ServerRuntime | undefined = await ServerRuntime.open(root);
    try {
      await expect(createBackup(root, archive, password)).rejects.toThrow(
        "owned",
      );
      const cipher = await ServerCipher.open(root, false);
      await fs.writeFile(
        path.join(root, "credential.vault"),
        cipher.encrypt("private-auth-fixture"),
        { mode: 0o600 },
      );
      const upload = await runtime.uploads.put(
        "1c17b6f4-8143-4663-80d5-0a8983c0d043",
        "中文 evidence.txt",
        Buffer.from("Evidence"),
      );
      await runtime.close();
      runtime = undefined;
      const temporary = path.join(root, "runtime/jobs/backup-fixture/.tmp");
      await fs.mkdir(path.join(temporary, "plugins"), { recursive: true });
      const cache = await fs.open(path.join(temporary, "plugins/catalog.pack"), "w");
      await cache.truncate(65 * 1024 * 1024);
      await cache.close();
      await fs.writeFile(path.join(temporary, "keep.txt"), "retain other temporary data");
      await fs.mkdir(path.join(root, "empty"));
      await fs.writeFile(
        path.join(root, "历史记录.json"),
        JSON.stringify({ content: "中文内容".repeat(20000) }),
        { mode: 0o600 },
      );
      await createBackup(root, archive, password);
      expect(
        (await fs.readFile(archive)).includes(
          Buffer.from("private-auth-fixture"),
        ),
      ).toBe(false);
      const verified = await verifyBackup(archive, password);
      expect(verified.root).toBe(root);
      expect(verified.entries).toBeGreaterThan(5);
      await expect(createBackup(root, archive, password)).rejects.toThrow();
      await expect(restoreBackup(archive, root, password)).rejects.toThrow(
        "must not exist",
      );
      await expect(
        verifyBackup(archive, "wrong password long enough"),
      ).rejects.toThrow();
      const damaged = path.join(base, "damaged.crb"),
        bytes = await fs.readFile(archive);
      bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(damaged, bytes, { mode: 0o600 });
      await fs.rename(root, path.join(base, "original"));
      await expect(restoreBackup(damaged, root, password)).rejects.toThrow();
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        restoreBackup(archive, path.join(base, "different"), password),
      ).rejects.toThrow("original absolute");
      await restoreBackup(archive, root, password);
      await expect(fs.stat(path.join(temporary, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(temporary, "keep.txt"), "utf8")).toBe("retain other temporary data");
      expect((await fs.stat(root)).mode & 0o077).toBe(0);
      expect((await fs.stat(archive)).mode & 0o077).toBe(0);
      const restoredCipher = await ServerCipher.open(root, false);
      expect(
        restoredCipher.decrypt(
          await fs.readFile(path.join(root, "credential.vault")),
        ),
      ).toBe("private-auth-fixture");
      runtime = await ServerRuntime.open(root);
      expect(await runtime.uploads.read(upload.id)).toEqual(upload);
      await runtime.close();
      runtime = undefined;
      await fs.symlink(path.join(base, "original"), path.join(root, "escape"));
      await expect(
        createBackup(root, path.join(base, "links.crb"), password),
      ).rejects.toThrow("links");
      const passwordFile = path.join(base, "password");
      await fs.writeFile(passwordFile, password, { mode: 0o600 });
      expect(await backupPassword(passwordFile)).toBe(password);
      await fs.chmod(passwordFile, 0o644);
      await expect(backupPassword(passwordFile)).rejects.toThrow("owner-only");
      expect(
        (await fs.readdir(base)).some((n) => n.startsWith(".relay-")),
      ).toBe(false);
    } finally {
      await runtime?.close();
      await fs.rm(base, { recursive: true, force: true });
    }
  },
);
