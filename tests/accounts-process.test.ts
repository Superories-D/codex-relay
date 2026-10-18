import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Accounts } from "../src/core/accounts";
import { Store } from "../src/core/store";
vi.mock("../src/core/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/process")>();
  return {
    ...actual,
    spawnCodex: async (_cli: string, _args: string[], home: string) =>
      spawn(
        process.execPath,
        [path.join(process.cwd(), "tests/fixtures/refresh-app-server.cjs")],
        {
          env: { ...process.env, RELAY_TEST_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
  };
});
it("shares a real refresh subprocess, writes encrypted rotated credentials, and recovers a failed rotation without replaying stale tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-refresh-")),
    store = new Store(root);
  const key = randomBytes(32);
  const accounts = new Accounts(
    store,
    {
      encrypt(text) {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        const data = Buffer.concat([
          cipher.update(text, "utf8"),
          cipher.final(),
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), data]);
      },
      decrypt(data) {
        const cipher = createDecipheriv(
          "aes-256-gcm",
          key,
          data.subarray(0, 12),
        );
        cipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString("utf8");
      },
    },
    () => {},
  );
  try {
    const a = await accounts.import(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "synthetic",
          id_token: "synthetic-id",
          access_token: "synthetic-initial",
          refresh_token: "synthetic-initial-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      }),
    );
    const home = store.profileHome(a.id),
      file = path.join(home, "auth.json");
    const journal = async () =>
      (await fs.readFile(path.join(home, "refresh-journal.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => accounts.refreshTokens(a.id)),
    );
    expect(new Set(results.map((r) => r.tokens.access_token))).toEqual(
      new Set(["synthetic-generation-1"]),
    );
    expect(await journal()).toHaveLength(1);
    expect((await accounts.auth(a.id)).tokens.refresh_token).toBe(
      "synthetic-rotated-1",
    );
    expect(
      (await fs.readFile(path.join(root, "vault", `${a.id}.vault`))).includes(
        Buffer.from("synthetic-rotated-1"),
      ),
    ).toBe(false);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(home, "fail-after-rotate"), "");
    const failed = await Promise.allSettled([
      accounts.refreshTokens(a.id),
      accounts.refreshTokens(a.id),
    ]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((await accounts.auth(a.id)).tokens.access_token).toBe(
      "synthetic-generation-1",
    );
    expect(
      JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token,
    ).toBe("synthetic-generation-2");
    await accounts.refreshTokens(a.id);
    expect((await accounts.auth(a.id)).tokens.access_token).toBe(
      "synthetic-generation-3",
    );
    const calls = await journal();
    expect(calls.map((c) => c.prior)).toEqual([
      "synthetic-initial",
      "synthetic-generation-1",
      "synthetic-generation-2",
    ]);
    expect(calls.every((c) => c.refreshToken === true)).toBe(true);
    for (const call of calls) expect(() => process.kill(call.pid, 0)).toThrow();
    await expect(
      fs.stat(path.join(home, "relay-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await accounts.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20000);
