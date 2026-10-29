const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function endpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw Error(
      "Use an HTTP(S) origin without credentials, query, fragment or path",
    );
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw Error("Use HTTPS or an SSH loopback tunnel");
  return url.origin;
}
function home() {
  return path.resolve(
    process.env.RELAY_REMOTE_HOME ||
      path.join(
        process.platform === "win32"
          ? process.env.APPDATA || os.homedir()
          : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "codex-relay",
        "remote",
      ),
  );
}
function protect(root) {
  if (root === path.parse(root).root || root === os.homedir())
    throw Error("Choose a dedicated remote client directory");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Remote client home must be a regular directory");
  if (process.platform === "win32")
    execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(__dirname, "windows", "protect-directory.ps1"),
        "-Directory",
        root,
      ],
      {
        windowsHide: true,
        timeout: 60000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => k.toUpperCase() !== "PSMODULEPATH",
          ),
        ),
        stdio: "pipe",
      },
    );
  else if (
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Remote client home must be owner-only (0700)");
}
function privateRead(file, max = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > max ||
    (process.platform !== "win32" &&
      (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw Error(
      "Client file must be private, regular and within the size limit",
    );
  if (process.platform === "win32")
    execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(__dirname, "windows", "verify-private-file.ps1"),
        "-TargetFile",
        file,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => k.toUpperCase() !== "PSMODULEPATH",
          ),
        ),
        stdio: "pipe",
      },
    );
  return fs.readFileSync(file, "utf8");
}
function atomic(file, value, exclusive = false) {
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
class RemoteStore {
  constructor(root = home()) {
    this.root = path.resolve(root);
    protect(this.root);
    for (const name of ["profiles", "requests", "credentials"]) {
      const dir = path.join(this.root, name);
      fs.mkdirSync(dir, { mode: 0o700, recursive: true });
      const s = fs.lstatSync(dir);
      if (!s.isDirectory() || s.isSymbolicLink())
        throw Error("Client storage directory is unsafe");
    }
  }
  profileFile(name) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name || ""))
      throw Error(
        "Profile name must be 1–64 letters, numbers, underscores or hyphens",
      );
    return path.join(this.root, "profiles", name + ".json");
  }
  saveProfile(name, input) {
    const file = this.profileFile(name),
      url = endpoint(input.url),
      token = privateRead(path.resolve(input.tokenFile), 1024).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid HTTP token file");
    const tokenFile = path.join(
      this.root,
      "credentials",
      name + "-" + crypto.randomUUID(),
    );
    fs.writeFileSync(tokenFile, token, { flag: "wx", mode: 0o600 });
    const result = {
      version: 1,
      url,
      tokenFile,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.tunnel ? { tunnel: input.tunnel } : {}),
    };
    try {
      atomic(file, result);
    } catch (e) {
      fs.rmSync(tokenFile, { force: true });
      throw e;
    }
    return { name, url, cwd: result.cwd };
  }
  profile(name) {
    const value = JSON.parse(privateRead(this.profileFile(name)));
    if (
      value.version !== 1 ||
      typeof value.tokenFile !== "string" ||
      !path.isAbsolute(value.tokenFile)
    )
      throw Error("Invalid profile");
    return { ...value, url: endpoint(value.url) };
  }
  profiles() {
    return fs
      .readdirSync(path.join(this.root, "profiles"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const name = f.slice(0, -5),
          p = this.profile(name);
        return { name, url: p.url, cwd: p.cwd };
      });
  }
  removeProfile(name) {
    const file = this.profileFile(name);
    fs.unlinkSync(file);
    return { removed: name };
  }
  requestFile(id) {
    if (!uuid.test(id || "")) throw Error("Request ID must be a UUID");
    return path.join(this.root, "requests", id + ".json");
  }
  read(id) {
    const value = JSON.parse(privateRead(this.requestFile(id)));
    if (
      value.version !== 1 ||
      value.requestId !== id ||
      !uuid.test(value.serverId || "")
    )
      throw Error("Invalid stored request");
    return value;
  }
  begin(url, serverId, name, args) {
    const id = args.requestId,
      file = this.requestFile(id);
    if (!uuid.test(serverId || ""))
      throw Error(
        "Server installation identity unavailable; upgrade the server",
      );
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify({ url, serverId, name, args }))
      .digest("hex");
    let previous;
    try {
      previous = this.read(id);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw Error(
          "Request ID conflicts with a different payload or server installation",
        );
      return previous;
    }
    const value = {
      version: 1,
      requestId: id,
      url,
      serverId,
      name,
      args,
      fingerprint,
      state: "pending",
      at: Date.now(),
    };
    try {
      atomic(file, value, true);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      return this.begin(url, serverId, name, args);
    }
    return value;
  }
  finish(record, result, error) {
    const value = {
      ...record,
      state: error ? "rejected" : "confirmed",
      ...(error ? { error } : { result }),
      finishedAt: Date.now(),
    };
    atomic(this.requestFile(record.requestId), value);
    return value;
  }
  reopen(record) {
    if (record.state !== "rejected") return record;
    const { error, finishedAt, result, ...previous } = record;
    const value = { ...previous, state: "pending", previousError: error };
    atomic(this.requestFile(record.requestId), value);
    return value;
  }
  requests() {
    return fs
      .readdirSync(path.join(this.root, "requests"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.read(f.slice(0, -5)))
      .sort((a, b) => b.at - a.at)
      .map(({ requestId, url, name, state, at }) => ({
        requestId,
        url,
        name,
        state,
        at,
      }));
  }
}
module.exports = { RemoteStore, endpoint, privateRead, home };
