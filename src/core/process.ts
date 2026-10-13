import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
export async function resolveCli(
  configured: string,
): Promise<{ executable: string; prefix: string[] }> {
  let exe = configured;
  if (!path.isAbsolute(exe)) {
    const extensions =
      process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    outer: for (const dir of (process.env.PATH ?? "").split(path.delimiter))
      for (const ext of extensions) {
        const candidate = path.join(dir, exe + ext);
        try {
          await fs.access(candidate);
          exe = candidate;
          break outer;
        } catch {}
      }
  }
  // npm's Windows shim isn't an executable. Resolve its JS entry without shell=true.
  if (/\.(cmd|bat)$/i.test(exe)) {
    const entry = path.join(
      path.dirname(exe),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    await fs.access(entry);
    const node = path.join(path.dirname(exe), "node.exe");
    try {
      await fs.access(node);
      return { executable: node, prefix: [entry] };
    } catch {
      return { executable: "node.exe", prefix: [entry] };
    }
  }
  return { executable: exe, prefix: [] };
}
export async function spawnCodex(
  cli: string,
  args: string[],
  home: string,
): Promise<ChildProcessWithoutNullStreams> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const resolved = await resolveCli(cli);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["CODEX_HOME", "OPENAI_API_KEY"].includes(key.toUpperCase()),
    ),
  );
  env.CODEX_HOME = home;
  // Subscription tasks must not silently switch to inherited API-key billing.
  delete env.OPENAI_API_KEY;
  return spawn(resolved.executable, [...resolved.prefix, ...args], {
    env,
    cwd: home,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
export async function terminateTree(
  proc: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode != null || !proc.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(proc.pid), "/T", "/F"],
        { windowsHide: true },
      );
      killer.once("error", reject);
      killer.once("close", (code) =>
        code === 0 || proc.exitCode !== null
          ? resolve()
          : reject(new Error("无法确认受管 Codex 进程树已停止")),
      );
    });
  } else proc.kill("SIGTERM");
  if (proc.exitCode === null && proc.signalCode == null)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Codex process did not exit")),
        5000,
      );
      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
}
