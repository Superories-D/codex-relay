import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { verifyDelivery } from "../src/core/delivery";
import {
  deliveryChecksSchema,
  type DeliveryCheck,
} from "../src/shared/delivery";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-delivery-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const run = (checks: DeliveryCheck[], signal?: AbortSignal) =>
  verifyDelivery(root, checks, { revision: 1, source: "manual", signal });
it("rejects a composite pass when one file is replaced between its individual acceptance checks", async () => {
  const target=path.join(root,"coherent.txt");await fs.writeFile(target,"original");
  const originalOpen=fs.open.bind(fs);let reads=0;
  const open=vi.spyOn(fs,"open").mockImplementation(async (...args) => {
    const handle=await originalOpen(...args);
    if(String(args[0]).endsWith(path.sep+"coherent.txt")&&++reads===1){
      const close=handle.close.bind(handle);
      handle.close=async()=>{await close();await fs.writeFile(target,"modified");};
    }
    return handle;
  });
  try{
    const report=await run([{kind:"file",path:"coherent.txt",label:"Exists",minBytes:1},
      {kind:"contains",path:"coherent.txt",label:"New content",text:"modified"}]);
    expect(report.status).toBe("unverified");expect(report.findings.every(f=>f.code==="changedDuringRead")).toBe(true);
    expect(new Set(report.findings.map(f=>f.sha256)).size).toBe(2);
  }finally{open.mockRestore();}
});
it("records byte count and SHA256 from actual files, including empty-file policies", async () => {
  await fs.writeFile(path.join(root, "产物.txt"), "completed\n");
  await fs.writeFile(path.join(root, "empty"), "");
  const report = await run([
    { kind: "file", label: "Result", path: "产物.txt", minBytes: 1 },
    { kind: "file", label: "Empty permitted", path: "empty", minBytes: 0 },
    { kind: "file", label: "Empty rejected", path: "empty", minBytes: 1 },
  ]);
  expect(report.status).toBe("failed");
  expect(report.findings.map((f) => f.status)).toEqual([
    "passed",
    "passed",
    "failed",
  ]);
  expect(report.findings[0]).toMatchObject({
    bytes: 10,
    sha256: createHash("sha256").update("completed\n").digest("hex"),
  });
});
it("finds Unicode literals across read boundaries and hashes the complete file", async () => {
  const text = "a".repeat(65535) + "检查✅跨边界" + "b".repeat(150000);
  await fs.writeFile(path.join(root, "result.txt"), text);
  const report = await run([
    {
      kind: "contains",
      path: "result.txt",
      label: "Unicode",
      text: "检查✅跨边界",
    },
    { kind: "contains", path: "result.txt", label: "One character", text: "b" },
    {
      kind: "contains",
      path: "result.txt",
      label: "Absent",
      text: "not found",
    },
  ]);
  expect(report.findings.map((f) => f.status)).toEqual([
    "passed",
    "passed",
    "failed",
  ]);
  expect(report.findings[0].sha256).toBe(
    createHash("sha256").update(text).digest("hex"),
  );
});
it("does not accept invalid UTF-8 even if the requested literal precedes it", async () => {
  await fs.writeFile(path.join(root, "bad"), Buffer.from([97, 98, 99, 255]));
  expect(
    (await run([{ kind: "contains", path: "bad", label: "Text", text: "abc" }]))
      .findings[0],
  ).toMatchObject({ status: "unverified", code: "invalidText", bytes: 4 });
});
it("supports exact hashes and typed JSON Pointer predicates without evaluating code", async () => {
  const data = JSON.stringify({ "a/b": { "~value": [false, 0, "0", null] } });
  await fs.writeFile(path.join(root, "data.json"), data);
  const report = await run([
    {
      kind: "sha256",
      path: "data.json",
      label: "Hash",
      sha256: createHash("sha256").update(data).digest("hex"),
    },
    {
      kind: "json",
      path: "data.json",
      label: "False",
      pointer: "/a~1b/~0value/0",
      equals: false,
    },
    {
      kind: "json",
      path: "data.json",
      label: "Typed",
      pointer: "/a~1b/~0value/1",
      equals: "0",
    },
    {
      kind: "json",
      path: "data.json",
      label: "Missing",
      pointer: "/toString",
      equals: null,
    },
  ]);
  expect(report.findings.map((f) => f.status)).toEqual([
    "passed",
    "passed",
    "failed",
    "failed",
  ]);
});
it("returns unverified for oversized JSON instead of accepting a partial document", async () => {
  await fs.writeFile(
    path.join(root, "large.json"),
    JSON.stringify({ value: "x".repeat(4 * 1024 * 1024) }),
  );
  const result = await run([
    {
      kind: "json",
      path: "large.json",
      label: "Size",
      pointer: "/value",
      equals: "x",
    },
  ]);
  expect(result.findings[0]).toMatchObject({
    status: "unverified",
    code: "jsonTooLarge",
  });
  expect(result.findings[0].sha256).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects paths outside the workspace on every supported host syntax", () => {
  for (const file of [
    "../secret",
    "x/../secret",
    "/secret",
    "C:\\secret",
    "\\\\host\\share",
    "x:stream",
    "x\\..\\secret",
    "./result",
    "x//result",
  ]) {
    expect(
      deliveryChecksSchema.safeParse([
        { kind: "file", path: file, label: "Unsafe", minBytes: 1 },
      ]).success,
      file,
    ).toBe(false);
  }
});
it("distinguishes missing paths and directories from successful artifacts", async () => {
  await fs.mkdir(path.join(root, "directory"));
  const report = await run([
    { kind: "file", path: "missing", label: "Missing", minBytes: 0 },
    { kind: "file", path: "directory", label: "Directory", minBytes: 0 },
  ]);
  expect(report.findings.map((f) => f.code)).toEqual(["missing", "notFile"]);
});
it("rejects a directory junction escaping the task root", async () => {
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-delivery-outside-"),
  );
  try {
    await fs.writeFile(path.join(outside, "secret"), "not a deliverable");
    await fs.symlink(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const report = await run([
      { kind: "file", path: "escape/secret", label: "Escape", minBytes: 0 },
    ]);
    expect(report.findings[0]).toMatchObject({
      status: "failed",
      code: "outsideWorkspace",
    });
    expect(report.findings[0].sha256).toBeUndefined();
  } finally {
    await fs.rm(path.join(root, "escape"), { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
it("cancellation is never recorded as a passed check", async () => {
  await fs.writeFile(path.join(root, "file"), "done");
  const abort = new AbortController();
  abort.abort();
  const report = await run(
    [{ kind: "file", path: "file", label: "Stop", minBytes: 0 }],
    abort.signal,
  );
  expect(report.status).toBe("unverified");
  expect(report.findings[0].code).toBe("cancelled");
  expect(JSON.stringify(report)).not.toContain('"signal"');
});
it("rejects evidence if the file changes while its contents are being read", async () => {
  const artifact = path.join(root, "changing");
  await fs.writeFile(artifact, "a".repeat(100000));
  const open = fs.open.bind(fs);
  let changed = false;
  const interception = vi
    .spyOn(fs, "open")
    .mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args),
        read = handle.read.bind(handle);
      handle.read = async (...values: any[]) => {
        const result = await read(...values);
        if (!changed) {
          changed = true;
          await fs.appendFile(artifact, "late edit");
        }
        return result;
      };
      return handle;
    });
  try {
    const report = await run([
      { kind: "contains", path: "changing", label: "Stable file", text: "a" },
    ]);
    expect(report.findings[0]).toMatchObject({
      status: "unverified",
      code: "changedDuringRead",
    });
  } finally {
    interception.mockRestore();
  }
});
