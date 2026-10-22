import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Cipher } from "../core/accounts";
export class ServerCipher implements Cipher {
  private constructor(private key: Buffer) {}
  static async open(root: string, allowCreate: boolean) {
    const file = path.join(root, "server-master.key");
    if (allowCreate) {
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
          await handle.writeFile(randomBytes(32));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error(
        "Server master key must be an owner-only regular file (0600)",
      );
    const key = await fs.readFile(file);
    if (key.length !== 32) throw Error("Invalid server master key");
    return new ServerCipher(key);
  }
  encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from("CRS1"),
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]);
  }
  decrypt(value: Buffer) {
    if (value.length < 32 || value.subarray(0, 4).toString() !== "CRS1")
      throw Error("Unsupported server vault format");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(4, 16),
    );
    cipher.setAuthTag(value.subarray(16, 32));
    return Buffer.concat([
      cipher.update(value.subarray(32)),
      cipher.final(),
    ]).toString("utf8");
  }
}
