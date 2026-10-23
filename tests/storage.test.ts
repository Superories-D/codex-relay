import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAuth } from "../src/core/accounts";
import { TranscriptTail } from "../src/core/transcript";
import { Store, atomicWrite } from "../src/core/store";
import { redact } from "../src/core/redact";
import { newJobSchema, settingsSchema } from "../src/main/validation";
describe("credential and transcript boundaries", () => {
  it("keeps atomic replacement on the actual new file's volume when AppData redirects only newly created files", async () => {
    const parent = path.resolve("qa-output");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "atomic-overlay-"));
    const logical = path.join(root, "logical"),
      physical = path.join(root, "physical");
    await fs.mkdir(logical);
    await fs.mkdir(physical);
    const original = path.join(logical, "state.json"),
      destination = path.join(physical, "state.json");
    await fs.writeFile(original, "global-old");
    await fs.writeFile(destination, "overlay-old");
    const open = fs.open.bind(fs),
      realpath = fs.realpath.bind(fs),
      rename = fs.rename.bind(fs);
    const redirected = (file: any) =>
      typeof file === "string" &&
      path.dirname(file) === logical &&
      file.endsWith(".tmp");
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(((file: any, ...args: any[]) =>
        open(
          redirected(file) ? path.join(physical, path.basename(file)) : file,
          ...args,
        )) as any);
    const pathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(((file: any, ...args: any[]) =>
        realpath(
          redirected(file) ? path.join(physical, path.basename(file)) : file,
          ...args,
        )) as any);
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (source, target) => {
        if (path.dirname(String(source)) === logical)
          throw Object.assign(Error("virtualized cross-device rename"), {
            code: "EXDEV",
          });
        return rename(source, target);
      });
    try {
      await atomicWrite(original, "overlay-new");
      expect(await fs.readFile(destination, "utf8")).toBe("overlay-new");
      expect(await fs.readFile(original, "utf8")).toBe("global-old");
      expect(await fs.readdir(physical)).toEqual(["state.json"]);
    } finally {
      openSpy.mockRestore();
      pathSpy.mockRestore();
      renameSpy.mockRestore();
      expect(path.dirname(await fs.realpath(root))).toBe(
        await fs.realpath(parent),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("preserves an existing destination and removes its temporary file if replacement is denied", async () => {
    const parent = path.resolve("qa-output");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "atomic-denied-")),
      file = path.join(root, "state.json");
    await fs.writeFile(file, "verified-old");
    const spy = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(Error("denied"), { code: "EPERM" }));
    try {
      await expect(atomicWrite(file, "new")).rejects.toMatchObject({
        code: "EPERM",
      });
      expect(await fs.readFile(file, "utf8")).toBe("verified-old");
      expect(await fs.readdir(root)).toEqual(["state.json"]);
    } finally {
      spy.mockRestore();
      expect(path.dirname(await fs.realpath(root))).toBe(
        await fs.realpath(parent),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("atomically creates and replaces files in the host's application data directory", async () => {
    const base =
      process.platform === "win32" ? process.env.APPDATA! : os.tmpdir();
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

it("retains the previous committed generation and refuses automatic rollback after primary corruption",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-generations-"));
 try{
 const store=new Store(root);await store.save();store.data.settings.retrySeconds=180;await store.save();
 expect(JSON.parse(await fs.readFile(path.join(root,"state.previous.json"),"utf8")).settings.retrySeconds).toBe(60);
 const loaded=new Store(root);await loaded.load();expect(loaded.data.settings.retrySeconds).toBe(180);
 await fs.writeFile(path.join(root,"state.json"),"{corrupt");await expect(new Store(root).load()).rejects.toThrow();
 expect(JSON.parse(await fs.readFile(path.join(root,"state.previous.json"),"utf8")).settings.retrySeconds).toBe(60);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
it("preserves the primary state if the previous-generation backup cannot be written",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-backup-fail-"));
 try{
 const store=new Store(root);await store.save();await fs.mkdir(path.join(root,"state.previous.json"));store.data.settings.retrySeconds=180;
 await expect(store.save()).rejects.toThrow();
 expect(JSON.parse(await fs.readFile(path.join(root,"state.json"),"utf8")).settings.retrySeconds).toBe(60);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
