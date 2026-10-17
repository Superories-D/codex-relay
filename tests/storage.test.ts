import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAuth } from "../src/core/accounts";
import { TranscriptTail } from "../src/core/transcript";
import { Store, atomicWrite } from "../src/core/store";
import { redact } from "../src/core/redact";
import { newJobSchema, settingsSchema } from "../src/main/validation";
describe("credential and transcript boundaries", () => {
  it("atomically creates and replaces files in the host's application data directory", async () => {
    const base = process.platform === "win32" ? process.env.APPDATA! : os.tmpdir();
    const dir = await fs.mkdtemp(path.join(base, "relay-atomic-test-"));
    const actual = await fs.realpath(dir);
    try {
      const file = path.join(dir, "state.json");
      await atomicWrite(file, '{"revision":1}');
      expect(await fs.readFile(file, "utf8")).toBe('{"revision":1}');
      await atomicWrite(file, '{"revision":2}');
      expect(await fs.readFile(file, "utf8")).toBe('{"revision":2}');
      expect(await fs.readdir(actual)).toEqual(["state.json"]);
    } finally {
      await fs.rm(actual, { recursive: true, force: true });
    }
  });
  it("rejects API-key credentials instead of billing a different provider", () => {
    expect(() =>
      parseAuth(JSON.stringify({ OPENAI_API_KEY: "synthetic" })),
    ).toThrow("API Key");
  });
  it("requires the account identity for imported OAuth credentials", () => {
    expect(() =>
      parseAuth(
        JSON.stringify({ tokens: { access_token: "x", id_token: "y" } }),
      ),
    ).toThrow("account_id");
  });
  it("redacts JWT, key, and refresh-token fields", () => {
    const value = redact(
      'eyJaaa.bbbbb.ccccc {"refresh_token":"private-value"} sk-abcdefghijklmnopqrst',
    );
    expect(value).not.toContain("private-value");
    expect(value).not.toContain("eyJaaa");
    expect(value).not.toContain("sk-abcdef");
  });
  it("handles split UTF-8 bytes and incomplete JSONL records without duplicates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-tail-"));
    const file = path.join(dir, "log.jsonl");
    try {
      await fs.writeFile(file, "");
      const tail = new TranscriptTail(file);
      await tail.seekEnd();
      const line = Buffer.from(
        JSON.stringify({ message: "额度归零了" }) + "\n",
      );
      const cut = line.indexOf(Buffer.from("额")) + 1;
      await fs.appendFile(file, line.subarray(0, cut));
      expect(await tail.read()).toEqual([]);
      await fs.appendFile(file, line.subarray(cut));
      expect(await tail.read()).toEqual([{ message: "额度归零了" }]);
      expect(await tail.read()).toEqual([]);
      await fs.writeFile(file, "");
      await expect(tail.read()).rejects.toThrow("截断");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("does not hide a corrupted state file by resetting to an empty account list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
    try {
      await fs.writeFile(path.join(dir, "state.json"), "{bad");
      await expect(new Store(dir).load()).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("validates the IPC trust boundary, absolute workspace and polling bounds", () => {
    expect(newJobSchema.safeParse({ cwd: "relative" }).success).toBe(false);
    expect(settingsSchema.safeParse({ pollSeconds: 0 }).success).toBe(false);
  });
});
