import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  deliveryChecksSchema,
  type DeliveryCheck,
  type DeliveryFinding,
  type DeliveryReport,
} from "../shared/delivery";

class EvidenceError extends Error {
  constructor(readonly code: DeliveryFinding["code"]) {
    super(code);
  }
}
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const sameFile = (a: import("node:fs").Stats, b: import("node:fs").Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const JSON_MAX_BYTES = 4 * 1024 * 1024;

async function inspect(
  root: string,
  check: DeliveryCheck,
  signal: AbortSignal,
): Promise<DeliveryFinding> {
  const base: DeliveryFinding = {
    check,
    status: "unverified",
    code: "ioError",
  };
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    signal.throwIfAborted();
    const candidate = path.resolve(root, ...check.path.split(/[\\/]/));
    if (!within(root, candidate)) throw new EvidenceError("outsideWorkspace");
    const target = await fs.realpath(candidate);
    if (!within(root, target)) throw new EvidenceError("outsideWorkspace");
    const before = await fs.stat(target);
    if (!before.isFile()) throw new EvidenceError("notFile");
    // Bind reads to the verified regular file. Recheck both the handle and path
    // so swaps and concurrent writes cannot be reported as verified evidence.
    file = await fs.open(
      target,
      constants.O_RDONLY |
        (process.platform === "win32"
          ? 0
          : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    const opened = await file.stat();
    if (!sameFile(before, opened) || (await fs.realpath(candidate)) !== target)
      throw new EvidenceError("changedDuringRead");
    const hash = createHash("sha256"),
      decoder =
        check.kind === "contains"
          ? new TextDecoder("utf-8", { fatal: true })
          : undefined;
    let tail = "",
      found = false,
      invalidText = false,
      bytes = 0;
    const json: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      signal.throwIfAborted();
      const result = await file.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > opened.size) throw new EvidenceError("changedDuringRead");
      if (check.kind === "json" && bytes <= JSON_MAX_BYTES)
        json.push(Buffer.from(chunk));
      if (decoder && check.kind === "contains" && !invalidText) {
        try {
          const text = tail + decoder.decode(chunk, { stream: true });
          if (text.includes(check.text)) found = true;
          tail =
            check.text.length > 1 ? text.slice(-(check.text.length - 1)) : "";
        } catch {
          invalidText = true;
        }
      }
    }
    if (decoder && check.kind === "contains" && !invalidText) {
      try {
        if ((tail + decoder.decode()).includes(check.text)) found = true;
      } catch {
        invalidText = true;
      }
    }
    signal.throwIfAborted();
    if (
      !sameFile(opened, await file.stat()) ||
      !sameFile(opened, await fs.stat(target)) ||
      bytes !== opened.size ||
      (await fs.realpath(candidate)) !== target ||
      (await fs.realpath(root)) !== root
    )
      throw new EvidenceError("changedDuringRead");
    Object.assign(base, {
      bytes,
      sha256: hash.digest("hex"),
      modifiedAt: opened.mtimeMs,
    });
    let passed = false,
      code: DeliveryFinding["code"] = "verified";
    if (check.kind === "file") {
      passed = bytes >= check.minBytes;
      code = passed ? "verified" : "tooSmall";
    }
    if (check.kind === "sha256") {
      passed = base.sha256 === check.sha256;
      code = passed ? "verified" : "hashMismatch";
    }
    if (check.kind === "contains") {
      if (invalidText) throw new EvidenceError("invalidText");
      passed = found;
      code = passed ? "verified" : "textMissing";
    }
    if (check.kind === "json") {
      if (bytes > JSON_MAX_BYTES) throw new EvidenceError("jsonTooLarge");
      let data: unknown;
      try {
        data = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(json)),
        );
      } catch {
        throw new EvidenceError("invalidText");
      }
      const keys = check.pointer
        ? check.pointer
            .slice(1)
            .split("/")
            .map((v) => v.replace(/~1/g, "/").replace(/~0/g, "~"))
        : [];
      for (const key of keys) {
        if (
          data === null ||
          typeof data !== "object" ||
          !Object.hasOwn(data, key)
        ) {
          data = undefined;
          break;
        }
        data = (data as Record<string, unknown>)[key];
      }
      passed = Object.is(data, check.equals);
      code = passed ? "verified" : "jsonMismatch";
    }
    return { ...base, status: passed ? "passed" : "failed", code };
  } catch (error: any) {
    const code = signal.aborted
      ? "cancelled"
      : error instanceof EvidenceError
        ? error.code
        : error.code === "ENOENT"
          ? "missing"
          : "ioError";
    return {
      ...base,
      code,
      status: ["missing", "notFile", "outsideWorkspace"].includes(code)
        ? "failed"
        : "unverified",
    };
  } finally {
    await file?.close();
  }
}

export async function verifyDelivery(
  cwd: string,
  input: DeliveryCheck[],
  options: {
    revision: number;
    source: DeliveryReport["source"];
    turnId?: string;
    signal?: AbortSignal;
  },
): Promise<DeliveryReport> {
  const checks = deliveryChecksSchema.parse(input),
    startedAt = Date.now();
  // A valid large artifact may take more than two minutes on a slow disk.
  // Read every byte until completion or explicit owner cancellation. Growth
  // beyond the opened size is rejected inside the read loop.
  const signal = options.signal ?? new AbortController().signal;
  const findings: DeliveryFinding[] = [];
  let root: string;
  try {
    root = await fs.realpath(cwd);
  } catch {
    return {
      id: randomUUID(),
      revision: options.revision,
      source: options.source,
      turnId: options.turnId,
      startedAt,
      finishedAt: Date.now(),
      status: "unverified",
      findings: checks.map((check) => ({
        check,
        status: "unverified",
        code: "ioError",
      })),
    };
  }
  for (const check of checks) findings.push(await inspect(root, check, signal));
  const fingerprints = new Map<string, Set<string>>();
  const key = (finding: DeliveryFinding) => {
    const value = path.resolve(root, finding.check.path.replaceAll("\\", "/"));
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  for (const finding of findings) if (finding.sha256) {
    const name = key(finding), hashes = fingerprints.get(name) ?? new Set<string>();
    hashes.add(finding.sha256); fingerprints.set(name, hashes);
  }
  // Multiple conditions for one artifact must describe the same observed bytes,
  // even when it is replaced between otherwise successful individual reads.
  for (const finding of findings) if ((fingerprints.get(key(finding))?.size ?? 0) > 1) {
    finding.status = "unverified"; finding.code = "changedDuringRead";
  }
  if ((await fs.realpath(cwd).catch(() => "")) !== root)
    for (const finding of findings) {
      finding.status = "unverified";
      finding.code = "changedDuringRead";
    }
  return {
    id: randomUUID(),
    revision: options.revision,
    source: options.source,
    turnId: options.turnId,
    startedAt,
    finishedAt: Date.now(),
    findings,
    status: findings.some((f) => f.status === "failed")
      ? "failed"
      : findings.some((f) => f.status === "unverified")
        ? "unverified"
        : "passed",
  };
}
