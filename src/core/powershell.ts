import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// PowerShell 7 and IDE hosts can export module paths that are incompatible with
// Windows PowerShell 5.1. Let powershell.exe rebuild its own default module path.
export function windowsPowerShellEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => key.toUpperCase() !== "PSMODULEPATH",
    ),
  );
}
export async function protectDataDirectory(script: string, directory: string) {
  try {
    await promisify(execFile)(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
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
        script,
        "-Directory",
        directory,
      ],
      { windowsHide: true, timeout: 60000, env: windowsPowerShellEnv() },
    );
  } catch (error: any) {
    const detail = error.killed
      ? "权限配置超过 60 秒仍未完成，请重试；如持续失败，请检查磁盘或安全软件。"
      : String(error.stderr || error.message || error).trim();
    throw new Error(`无法保护数据目录：${directory}\n${detail}`);
  }
}
