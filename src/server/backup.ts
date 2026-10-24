import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { acquireOwner } from "./owner";
const MAGIC = Buffer.from("CRBACK01"),
  HEADER = 36,
  MAX_FILE = 64 * 1024 * 1024,
  MAX_TOTAL = 512 * 1024 * 1024,
  MAX_FILES = 10000;
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
async function privateFile(file: string) {
  const s = await fs.lstat(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw Error("File must be owner-only and regular (0600)");
  return s;
}
export async function backupPassword(file: string) {
  const stat = await privateFile(file);
  if (stat.size > 65536) throw Error("Password file is too large");
  const value = (await fs.readFile(file, "utf8")).trim();
  if (value.length < 16)
    throw Error("Backup password must have at least 16 characters");
  return value;
}
const key = (password: string, salt: Buffer) =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
function relative(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 32700 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((p) => !p || p === "." || p === "..") ||
    path.isAbsolute(value)
  )
    throw Error("Unsafe backup path");
  return value;
}
async function privateRoot(root: string) {
  const stat = await fs.lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Data directory must be owner-only (0700)");
}
export async function createBackup(
  directory: string,
  output: string,
  password: string,
) {
  if (process.platform !== "linux")
    throw Error("Server backup requires Linux ownership locking");
  const root = await fs.realpath(directory);
  await privateRoot(root);
  const destination = path.resolve(output),
    parent = await fs.realpath(path.dirname(destination));
  const rel = path.relative(root, parent);
  if (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  ) {
    throw Error("Backup output must be outside the data directory");
  }
  const owner = await acquireOwner(root);
  let lost = false;
  owner.onLost(() => {
    lost = true;
  });
  const temp = path.join(parent, `.relay-backup-${randomUUID()}.tmp`);
  let count = 0,
    total = 0;
  const excluded: string[] = [];
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(root, "server-installation.json"), "utf8"),
    );
    if (marker.kind !== "codex-relay-server")
      throw Error("Not a server installation");
    const state = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8"),
    );
    if (
      state.jobs.some(
        (j: any) =>
          j.recoveryRequired ||
          ["preparing", "running", "pausing", "rotating"].includes(j.state),
      ) ||
      state.accounts.some((a: any) =>
        Object.values(a.warmups || {}).some((w: any) => w.status === "running"),
      )
    )
      throw Error(
        "Finish process recovery and stop the service cleanly before backup",
      );
    const salt = randomBytes(16),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key(password, salt), iv),
      header = Buffer.concat([MAGIC, salt, iv]);
    cipher.setAAD(header);
    await fs.writeFile(temp, header, { flag: "wx", mode: 0o600 });
    const digest = createHash("sha256");
    async function* walk(dir: string): AsyncGenerator<string> {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const file = path.join(dir, entry.name),
          name = relative(path.relative(root, file).split(path.sep).join("/"));
        if (["server.lock", "relay.sock"].includes(name)) {
          excluded.push(name);
          continue;
        }
        if (lost) throw Error("Backup ownership was lost");
        const stat = await fs.lstat(file);
        // Codex downloads a disposable plugin catalog checkout here for each home.
        // Keep other temporary files and all installed skills/plugins in the backup.
        if (stat.isDirectory() && /^runtime\/jobs\/[^/]+\/\.tmp\/plugins$/.test(name)) {
          excluded.push(name);
          continue;
        }
        if (
          stat.isSymbolicLink() &&
          /^runtime\/jobs\/[^/]+\/(skills|plugins)$/.test(name)
        ) {
          excluded.push(name);
          continue;
        }
        if (++count > MAX_FILES) throw Error("Backup exceeds 10000 entries");
        if (stat.isDirectory()) {
          const line = JSON.stringify({ type: "directory", name }) + "\n";
          digest.update(line);
          yield line;
          yield* walk(file);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1)
          throw Error("Backup refuses links and special files: " + name);
        if (stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL)
          throw Error("Backup exceeds 64 MiB per file or 512 MiB total");
        const handle = await fs.open(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        let bytes: Buffer;
        try {
          const before = await handle.stat();
          if (before.ino !== stat.ino || before.size !== stat.size)
            throw Error("Backup file changed");
          bytes = await handle.readFile();
          const after = await handle.stat();
          if (
            bytes.length !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            throw Error("Backup file changed");
        } finally {
          await handle.close();
        }
        const line =
          JSON.stringify({
            type: "file",
            name,
            mode: 0o600 | (stat.mode & 0o100),
            size: bytes.length,
            sha256: hash(bytes),
            data: bytes.toString("base64"),
          }) + "\n";
        digest.update(line);
        yield line;
      }
    }
    async function* records() {
      yield JSON.stringify({
        type: "header",
        version: 1,
        root,
        createdAt: new Date().toISOString(),
      }) + "\n";
      yield* walk(root);
      yield JSON.stringify({
        type: "end",
        count,
        total,
        sha256: digest.digest("hex"),
        excluded,
      }) + "\n";
    }
    await pipeline(
      Readable.from(records()),
      createGzip(),
      cipher,
      createWriteStream(temp, { flags: "a", mode: 0o600 }),
    );
    await fs.appendFile(temp, cipher.getAuthTag());
    const handle = await fs.open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (lost) throw Error("Backup ownership was lost");
    await fs.link(temp, destination);
    return { file: destination, entries: count, bytes: total, excluded };
  } finally {
    await fs.rm(temp, { force: true });
    await owner.release();
  }
}
async function consumeBackup(file: string, password: string, target?: string) {
  const stat = await privateFile(file);
  if (stat.size < HEADER + 16 || stat.size > MAX_TOTAL * 2)
    throw Error("Invalid backup size");
  const handle = await fs.open(file, "r"),
    header = Buffer.alloc(HEADER),
    tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, HEADER, 0);
    await handle.read(tag, 0, 16, stat.size - 16);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 8).equals(MAGIC))
    throw Error("Unsupported backup format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(password, header.subarray(8, 24)),
    header.subarray(24, 36),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const source = createReadStream(file, { start: HEADER, end: stat.size - 17 }),
    gunzip = createGunzip();
  // pipeline propagates authentication failures even when the gzip stream ended.
  const flow = pipeline(source, decipher, gunzip);
  void flow.catch(() => {});
  const decoder = new StringDecoder("utf8");
  let buffer = "",
    decoded = 0,
    count = 0,
    total = 0,
    manifest: any,
    end: any;
  const seen = new Set<string>(),
    digest = createHash("sha256");
  try {
    for await (const chunk of gunzip) {
      decoded += chunk.length;
      if (decoded > MAX_TOTAL * 1.5)
        throw Error("Expanded backup exceeds limit");
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_FILE * 1.5)
        throw Error("Backup record exceeds limit");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const record = JSON.parse(line);
        if (end) throw Error("Data follows backup footer");
        if (!manifest) {
          if (
            record.type !== "header" ||
            record.version !== 1 ||
            typeof record.root !== "string" ||
            !path.isAbsolute(record.root)
          )
            throw Error("Invalid backup header");
          manifest = record;
          continue;
        }
        if (record.type === "end") {
          end = record;
          continue;
        }
        const name = relative(record.name);
        if (seen.has(name) || ++count > MAX_FILES)
          throw Error("Duplicate path or too many entries");
        seen.add(name);
        digest.update(line + "\n");
        const output = target ? path.join(target, name) : undefined;
        if (record.type === "directory") {
          if (output) await fs.mkdir(output, { mode: 0o700 });
          continue;
        }
        if (
          record.type !== "file" ||
          !Number.isSafeInteger(record.size) ||
          record.size < 0 ||
          record.size > MAX_FILE ||
          (total += record.size) > MAX_TOTAL ||
          typeof record.data !== "string" ||
          record.data.length > MAX_FILE * 1.4
        )
          throw Error("Invalid backup entry");
        const bytes = Buffer.from(record.data, "base64");
        if (
          bytes.length !== record.size ||
          hash(bytes) !== record.sha256 ||
          bytes.toString("base64") !== record.data
        )
          throw Error("Backup checksum mismatch");
        if (output)
          await fs.writeFile(output, bytes, {
            flag: "wx",
            mode: record.mode === 0o700 ? 0o700 : 0o600,
          });
      }
    }
    await flow;
    buffer += decoder.end();
    if (
      buffer ||
      !end ||
      !manifest ||
      count !== end.count ||
      total !== end.total ||
      digest.digest("hex") !== end.sha256 ||
      !seen.has("state.json") ||
      !seen.has("server-master.key") ||
      !seen.has("server-installation.json")
    )
      throw Error("Incomplete backup");
    return {
      root: manifest.root,
      createdAt: manifest.createdAt,
      entries: count,
      bytes: total,
      excluded: end.excluded,
    };
  } catch (error) {
    source.destroy();
    decipher.destroy();
    gunzip.destroy();
    await flow.catch(() => {});
    throw error;
  }
}
export async function verifyBackup(file: string, password: string) {
  return consumeBackup(path.resolve(file), password);
}
export async function restoreBackup(
  file: string,
  directory: string,
  password: string,
) {
  const target = path.resolve(directory),
    parent = await fs.realpath(path.dirname(target));
  try {
    await fs.lstat(target);
    throw Error(
      "Restore destination must not exist; move existing data aside first",
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await fs.mkdtemp(path.join(parent, ".relay-restore-"));
  await fs.chmod(staging, 0o700);
  let reserved = false;
  try {
    const result = await consumeBackup(path.resolve(file), password, staging);
    if (result.root !== target)
      throw Error(
        "Restore requires the original absolute data directory to preserve native history and attachment paths",
      );
    // Exclusive reservation plus rename prevents merging into any existing data.
    await fs.mkdir(target, { mode: 0o700 });
    reserved = true;
    await fs.rename(staging, target);
    reserved = false;
    return { ...result, directory: target };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    if (reserved) await fs.rmdir(target).catch(() => {});
  }
}
