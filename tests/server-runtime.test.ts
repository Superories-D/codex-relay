import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it, describe } from "vitest";
import { ServerRuntime } from "../src/server/runtime";
import { ServerCipher } from "../src/server/vault";
import { acquireOwner } from "../src/server/owner";
describe.skipIf(process.platform !== "linux")("Linux headless runtime", () => {
  it("encrypts server credentials with authenticated encryption and refuses altered ciphertext or public keys", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "relay-server-vault-"),
    );
    try {
      const cipher = await ServerCipher.open(root, true);
      const value = cipher.encrypt("private credentials");
      expect(value.toString()).not.toContain("private credentials");
      expect(cipher.decrypt(value)).toBe("private credentials");
      expect((await ServerCipher.open(root, false)).decrypt(value)).toBe(
        "private credentials",
      );
      value[value.length - 1] ^= 1;
      expect(() => cipher.decrypt(value)).toThrow();
      await fs.chmod(path.join(root, "server-master.key"), 0o644);
      await expect(ServerCipher.open(root, false)).rejects.toThrow("0600");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("uses a kernel ownership lock with clean reacquisition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-server-lock-"));
    let lock = await acquireOwner(root);
    try {
      await expect(acquireOwner(root)).rejects.toThrow("already owned");
      await lock.release();
      lock = await acquireOwner(root);
    } finally {
      await lock.release();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("runs the scheduler without Electron, persists tasks and imports accounts only into an encrypted server vault", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-server-"));
    let runtime = await ServerRuntime.open(root);
    try {
      await runtime.scheduler.dispatch(true);
      const job: any = await runtime.command("job.add", {
        title: "Server task",
        prompt: "Run safely",
        cwd: root,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user",
          email: "synthetic@example.test",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "synthetic",
            chatgpt_plan_type: "plus",
          },
        }),
      ).toString("base64url");
      const account: any = await runtime.command("account.importText", {
        text: JSON.stringify({
          tokens: {
            id_token: `x.${payload}.x`,
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
          },
        }),
      });
      const files = await fs.readdir(path.join(root, "vault"));
      expect(files).toHaveLength(1);
      expect(
        (await fs.readFile(path.join(root, "vault", files[0]))).toString(),
      ).not.toContain("synthetic-access");
      expect(account.email).toBe("synthetic@example.test");
      await runtime.close();
      runtime = await ServerRuntime.open(root);
      const snap: any = await runtime.command("snapshot");
      expect(snap.jobs[0].id).toBe(job.id);
      expect(snap.dispatch.paused).toBe(true);
      await expect(
        runtime.command("job.add", {
          title: "x",
          prompt: "x",
          cwd: root,
          mode: "desktop",
          model: "",
          effort: "",
          bucket: "codex",
          approvalPolicy: "never",
          sandbox: "workspaceWrite",
        }),
      ).rejects.toThrow("Only CLI");
      await expect(runtime.command("data.open")).rejects.toThrow("unavailable");
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("refuses to reuse desktop state as server data", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "relay-server-desktop-"),
    );
    try {
      await fs.writeFile(path.join(root, "state.json"), "{}");
      await expect(ServerRuntime.open(root)).rejects.toThrow(
        "separate data directory",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
