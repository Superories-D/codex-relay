import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { resolveCli, terminateTree } from "./process";
import { windowsPowerShellEnv } from "./powershell";
import { redact } from "./redact";
import { ProcessSafetyError } from "./process-safety-error";
import type { CliSetupState } from "../shared/cli-setup";

// The app-server integration is validated against this release. Existing usable
// user installations are reused, not upgraded or uninstalled by startup checks.
export const MANAGED_CLI_RELEASE = "0.162.1";
export type CliSetupOptions = {
  root: string;
  configured: () => string;
  select: (cli: string, previous: string) => Promise<void>;
  changed?: (state: CliSetupState) => void;
};
type Dependencies = {
  probe: (cli: string) => Promise<string>;
  candidates: () => string[];
  install: (
    root: string,
    signal: AbortSignal,
    phase: (value: CliSetupState["phase"]) => void,
  ) => Promise<string>;
};

export async function probeCli(cli: string): Promise<string> {
  const resolved = await resolveCli(cli);
  const { stdout } = await promisify(execFile)(
    resolved.executable,
    [...resolved.prefix, "--version"],
    {
      timeout: 8000,
      maxBuffer: 16384,
      windowsHide: true,
      shell: false,
    },
  );
  const version = stdout.trim();
  if (!/^codex(?:-cli)?\s+\d+\.\d+\.\d+/i.test(version))
    throw Error("所选程序未返回 Codex 版本信息");
  return version.slice(0, 200);
}

export function defaultCliCandidates() {
  if (process.platform === "win32")
    return [
      ...(process.env.LOCALAPPDATA
        ? [
            path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "OpenAI",
              "Codex",
              "bin",
              "codex.exe",
            ),
          ]
        : []),
      ...(process.env.APPDATA
        ? [path.join(process.env.APPDATA, "npm", "codex.cmd")]
        : []),
    ];
  return [
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
}

async function installerProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  if (signal.aborted) throw Error("CLI 安装已停止");
  const child = spawn(executable, args, {
    env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let output = "",
    stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      // Shell installers have downloader/extractor descendants. A dedicated
      // Unix process group keeps cancellation from orphaning those helpers.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await terminateTree(child);
      if (process.platform !== "win32" && child.pid) {
        const deadline = Date.now() + 5000;
        while (true) {
          try {
            process.kill(-child.pid, 0);
          } catch (error: any) {
            if (error.code === "ESRCH") return;
            throw error;
          }
          if (Date.now() >= deadline)
            throw Error("CLI installer helpers are still running");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })();
    void stopping.catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 10 * 60 * 1000);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-12000);
    });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, exitSignal) => {
        if (signal.aborted || stopping) reject(Error("CLI 安装已停止或超时"));
        else if (code !== 0 || exitSignal)
          reject(
            Error(
              `CLI 安装失败 (${code ?? exitSignal})：${redact(output).slice(-3000)}`,
            ),
          );
        else resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (stopping) {
      try {
        await stopping;
      } catch (error) {
        throw new ProcessSafetyError("无法确认 CLI 安装进程已停止", error);
      }
    }
  }
}

export async function installManagedCli(
  root: string,
  signal: AbortSignal,
  phase: (value: CliSetupState["phase"]) => void,
) {
  if (!path.isAbsolute(root))
    throw Error("CLI installation root must be absolute");
  if (!["win32", "linux", "darwin"].includes(process.platform))
    throw Error("此平台暂不支持自动安装 Codex CLI");
  const home = path.join(root, "runtime", "managed-cli"),
    bin = path.join(home, "bin");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(home, "installer-"));
  try {
    phase("downloading");
    const script = process.platform === "win32" ? "install.ps1" : "install.sh";
    const response = await fetch(`https://chatgpt.com/codex/${script}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (
      !response.ok ||
      !response.body ||
      new URL(response.url).protocol !== "https:"
    )
      throw Error("无法下载官方 Codex CLI 安装器");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 2 * 1024 * 1024) throw Error("CLI 安装器超出下载大小限制");
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const source = Buffer.concat(chunks);
    if (
      source.length < 100 ||
      source.toString("utf8", 0, 100).includes("<html")
    )
      throw Error("官方 CLI 安装器内容无效");
    const file = path.join(temporary, script);
    await fs.writeFile(file, source, { mode: 0o600 });
    const env =
      process.platform === "win32"
        ? windowsPowerShellEnv()
        : { ...process.env };
    // A managed installation owns only its own runtime; user credentials and
    // existing standalone releases remain outside the installer's CODEX_HOME.
    env.CODEX_HOME = home;
    env.CODEX_INSTALL_DIR = bin;
    env.CODEX_NON_INTERACTIVE = "1";
    env.CODEX_RELEASE = MANAGED_CLI_RELEASE;
    delete env.CODEX_INSTALL_DAEMON_ONLY;
    delete env.OPENAI_API_KEY;
    phase("installing");
    const executable =
      process.platform === "win32"
        ? path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : "/bin/sh";
    const args =
      process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            file,
            "-Release",
            MANAGED_CLI_RELEASE,
          ]
        : [file, "--release", MANAGED_CLI_RELEASE];
    await installerProcess(executable, args, env, signal);
    return path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  } finally {
    // temporary is created directly inside the verified app-owned home above.
    if (path.dirname(temporary) !== home)
      throw Error("Invalid installer temporary directory");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export class CliSetup {
  state: CliSetupState = { phase: "checking" };
  private pending?: Promise<CliSetupState>;
  private controller?: AbortController;
  private closed = false;
  private stopFailure?: ProcessSafetyError;
  constructor(
    private options: CliSetupOptions,
    private dependencies: Dependencies = {
      probe: probeCli,
      candidates: defaultCliCandidates,
      install: installManagedCli,
    },
  ) {}
  private publish(state: CliSetupState) {
    this.state = state;
    this.options.changed?.(structuredClone(state));
  }
  ensure(): Promise<CliSetupState> {
    if (this.pending) return this.pending;
    if (this.closed || this.stopFailure) return Promise.resolve(this.state);
    const controller = (this.controller = new AbortController());
    const configured = this.options.configured();
    const operation = this.run(configured, controller.signal).catch((error) => {
      if (error instanceof ProcessSafetyError) this.stopFailure = error;
      this.publish({
        phase: "error",
        error: redact(error instanceof Error ? error.message : error).slice(
          0,
          3500,
        ),
      });
      return this.state;
    });
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    return operation;
  }
  private async run(configured: string, signal: AbortSignal) {
    this.publish({ phase: "checking" });
    const managed = path.join(
      this.options.root,
      "runtime",
      "managed-cli",
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    let selected = "",
      version = "";
    for (const candidate of [
      ...new Set([
        configured,
        "codex",
        managed,
        ...this.dependencies.candidates(),
      ]),
    ].filter(Boolean)) {
      if (signal.aborted) throw Error("CLI 安装已停止");
      try {
        version = await this.dependencies.probe(candidate);
        selected = candidate;
        break;
      } catch {}
    }
    if (!selected) {
      selected = await this.dependencies.install(
        this.options.root,
        signal,
        (phase) => this.publish({ phase }),
      );
      this.publish({ phase: "verifying" });
      version = await this.dependencies.probe(selected);
      if (
        !new RegExp(
          `^codex(?:-cli)?\\s+${MANAGED_CLI_RELEASE.replaceAll(".", "\\.")}(?:\\s|$)`,
        ).test(version)
      )
        throw Error("新安装的 CLI 版本验证失败");
    }
    if (signal.aborted || this.closed) throw Error("CLI 安装已停止");
    if (selected !== configured)
      await this.options.select(selected, configured);
    this.publish({ phase: "ready", path: selected, version });
    return this.state;
  }
  async shutdown() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
    if (this.stopFailure) throw this.stopFailure;
  }
}
