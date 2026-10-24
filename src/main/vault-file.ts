import { promises as fs, constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deliveryCheckSchema } from "../shared/delivery";
import { vaultPathSchema } from "../shared/vault";

export class VaultFileError extends Error {
  constructor(readonly code: "sourceChanged" | "sourceUnavailable" | "outsideWorkspace" | "destinationError" | "cancelled") {
    super(code);
  }
}
export class VaultIntegrityError extends Error {
  constructor(readonly code: "changed" | "unverified") {super(code);}
}
const inside = (root: string, file: string) => {
  const value = path.relative(root, file);
  return !!value && value !== ".." && !value.startsWith(".." + path.sep) && !path.isAbsolute(value);
};
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
function relative(value: string, code: "outsideWorkspace" | "destinationError" = "outsideWorkspace") {
  if (code === "destinationError") {
    const parsed = vaultPathSchema.safeParse(value);
    if (!parsed.success) throw new VaultFileError(code);
    return parsed.data.split(/[\\/]/);
  }
  const parsed = deliveryCheckSchema.safeParse({kind: "file", path: value, label: "Artifact", minBytes: 0});
  if (!parsed.success) throw new VaultFileError(code);
  return parsed.data.path.split(/[\\/]/);
}
async function outputPath(root: string, parts: string[]) {
  let folder = root;
  for (const segment of parts.slice(0, -1)) {
    const candidate = path.join(folder, segment);
    try {await fs.mkdir(candidate, {mode: 0o700});} catch (e) {if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;}
    folder = await fs.realpath(candidate);
    if (!inside(root, folder) || !(await fs.stat(folder)).isDirectory()) throw new VaultFileError("destinationError");
  }
  return path.join(folder, parts.at(-1)!);
}
export async function verifyVaultFile(root: string, artifact: {path: string; sha256: string; bytes: number}, signal?: AbortSignal,
  progress?: (bytes: number) => void) {
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    signal?.throwIfAborted();
    const base = await fs.realpath(root), candidate = path.resolve(base, ...relative(artifact.path, "destinationError")), target = await fs.realpath(candidate);
    if (!inside(base, target)) throw new VaultIntegrityError("changed");
    const before = await fs.stat(target);
    if (!before.isFile() || before.size !== artifact.bytes) throw new VaultIntegrityError("changed");
    file = await fs.open(target, flags); const opened = await file.stat();
    if (!same(before, opened) || await fs.realpath(candidate) !== target) throw new VaultIntegrityError("changed");
    const buffer = Buffer.allocUnsafe(64 * 1024), hash = createHash("sha256"); let count = 0;
    while (true) {
      signal?.throwIfAborted(); const result = await file.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      count += result.bytesRead; if (count > artifact.bytes) throw new VaultIntegrityError("changed");
      hash.update(buffer.subarray(0, result.bytesRead)); progress?.(count);
    }
    signal?.throwIfAborted();
    if (count !== artifact.bytes || hash.digest("hex") !== artifact.sha256 || !same(opened, await file.stat()) ||
      !same(opened, await fs.stat(target)) || await fs.realpath(candidate) !== target || await fs.realpath(root) !== base)
      throw new VaultIntegrityError("changed");
    return {bytes: count, sha256: artifact.sha256};
  } catch (error) {
    if (signal?.aborted) throw new VaultFileError("cancelled");
    if (error instanceof VaultIntegrityError) throw error;
    throw new VaultIntegrityError((error as NodeJS.ErrnoException).code === "ENOENT" ? "changed" : "unverified");
  } finally {await file?.close();}
}

// A real copy, never a hard link. Source and stored bytes must both match the
// accepted complete-file fingerprint before a vault coordinator may publish it.
export async function copyVerifiedArtifact(options: {
  cwd: string; relative: string; stagingRoot: string; output: string;
  sha256: string; bytes: number; signal?: AbortSignal;
  progress?: (value: {phase: "copying" | "verifying"; bytes: number}) => void;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.sha256) || !Number.isSafeInteger(options.bytes) || options.bytes < 0)
    throw new VaultFileError("sourceUnavailable");
  const sourceParts = relative(options.relative), outputParts = relative(options.output, "destinationError");
  const signal = options.signal ?? new AbortController().signal;
  let input: Awaited<ReturnType<typeof fs.open>> | undefined, output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let phase: "source" | "destination" = "source";
  try {
    signal.throwIfAborted();
    const workspace = await fs.realpath(options.cwd), candidate = path.resolve(workspace, ...sourceParts);
    const source = await fs.realpath(candidate);
    if (!inside(workspace, source)) throw new VaultFileError("outsideWorkspace");
    const before = await fs.stat(source);
    if (!before.isFile()) throw new VaultFileError("sourceUnavailable");
    if (before.size !== options.bytes) throw new VaultFileError("sourceChanged");
    input = await fs.open(source, flags);
    const opened = await input.stat();
    if (!opened.isFile() || !same(before, opened) || await fs.realpath(candidate) !== source) throw new VaultFileError("sourceChanged");
    phase = "destination";
    const staging = await fs.realpath(options.stagingRoot), destination = await outputPath(staging, outputParts);
    output = await fs.open(destination, "wx", 0o600);
    if (!inside(staging, await fs.realpath(destination))) throw new VaultFileError("destinationError");
    const created = await output.stat(), digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (true) {
      signal.throwIfAborted(); phase = "source";
      const chunk = await input.read(buffer, 0, buffer.length, null); if (!chunk.bytesRead) break;
      if (copied + chunk.bytesRead > options.bytes) throw new VaultFileError("sourceChanged");
      digest.update(buffer.subarray(0, chunk.bytesRead)); phase = "destination";
      let written = 0;
      while (written < chunk.bytesRead) {
        signal.throwIfAborted();
        const part = await output.write(buffer, written, chunk.bytesRead - written, null);
        if (!part.bytesWritten) throw new VaultFileError("destinationError");
        written += part.bytesWritten;
      }
      copied += chunk.bytesRead; options.progress?.({phase: "copying", bytes: copied});
    }
    signal.throwIfAborted(); phase = "source";
    if (copied !== options.bytes || digest.digest("hex") !== options.sha256 ||
      !same(opened, await input.stat()) || !same(opened, await fs.stat(source)) ||
      await fs.realpath(candidate) !== source || await fs.realpath(options.cwd) !== workspace)
      throw new VaultFileError("sourceChanged");
    await input.close(); input = undefined; phase = "destination";
    await output.sync();
    const stored = await output.stat();
    if (!stored.isFile() || stored.size !== copied || stored.dev !== created.dev || stored.ino !== created.ino)
      throw new VaultFileError("destinationError");
    await output.close(); output = undefined;
    // Read the destination again: successful writes alone do not constitute
    // verification of the stored artifact that will be handed off.
    const physical = await fs.realpath(destination);
    if (!inside(staging, physical)) throw new VaultFileError("destinationError");
    output = await fs.open(physical, flags);
    const check = await output.stat(), readback = createHash("sha256"); let verified = 0;
    if (!same(stored, check)) throw new VaultFileError("destinationError");
    while (true) {
      signal.throwIfAborted(); const chunk = await output.read(buffer, 0, buffer.length, null); if (!chunk.bytesRead) break;
      readback.update(buffer.subarray(0, chunk.bytesRead)); verified += chunk.bytesRead;
      if (verified > copied) throw new VaultFileError("destinationError");
      options.progress?.({phase: "verifying", bytes: verified});
    }
    signal.throwIfAborted();
    if (verified !== copied || readback.digest("hex") !== options.sha256 || !same(check, await output.stat()) ||
      !same(check, await fs.stat(physical)) || await fs.realpath(destination) !== physical || await fs.realpath(options.stagingRoot) !== staging)
      throw new VaultFileError("destinationError");
    return {bytes: verified, sha256: options.sha256, sourceModifiedAt: opened.mtimeMs};
  } catch (error) {
    if (signal.aborted) throw new VaultFileError("cancelled");
    if (error instanceof VaultFileError) throw error;
    throw new VaultFileError(phase === "source" ? "sourceUnavailable" : "destinationError");
  } finally {
    const closed = await Promise.allSettled([input?.close(), output?.close()]);
    if (closed.some(result => result.status === "rejected"))
      throw new VaultFileError(phase === "source" ? "sourceUnavailable" : "destinationError");
  }
}
