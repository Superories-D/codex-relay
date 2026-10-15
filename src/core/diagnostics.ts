import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolveCli } from "./process";
import { redact } from "./redact";
export interface Diagnostic {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}
export async function checkEnvironment(
  cli: string,
): Promise<{ checkedAt: number; checks: Diagnostic[] }> {
  const checks: Diagnostic[] = [];
  checks.push({
    name: "运行平台",
    status: process.platform === "win32" ? "ok" : "warning",
    detail:
      process.platform === "win32"
        ? "Windows；可使用 CLI 和 Desktop 适配"
        : "当前为开发环境，官方 Desktop 模式需要 Windows",
  });
  try {
    const resolved = await resolveCli(cli);
    const version = await promisify(execFile)(
      resolved.executable,
      [...resolved.prefix, "--version"],
      { timeout: 8000, maxBuffer: 16384, windowsHide: true, shell: false },
    );
    const text = version.stdout.trim();
    if (!/codex/i.test(text)) throw new Error("所选程序未返回 Codex 版本信息");
    checks.push({
      name: "Codex CLI",
      status: "ok",
      detail: text.slice(0, 200),
    });
  } catch (error) {
    checks.push({
      name: "Codex CLI",
      status: "error",
      detail: `无法读取 CLI 版本，请检查安装或路径。${redact(error instanceof Error ? error.message : error).slice(0, 400)}`,
    });
  }
  if (process.platform === "win32") {
    try {
      const ps = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = await promisify(execFile)(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$PSVersionTable.PSVersion.ToString()",
        ],
        { timeout: 8000, maxBuffer: 16384, windowsHide: true },
      );
      checks.push({
        name: "Windows PowerShell",
        status: "ok",
        detail: `版本 ${result.stdout.trim().slice(0, 100)}`,
      });
    } catch {
      checks.push({
        name: "Windows PowerShell",
        status: "error",
        detail: "PowerShell 不可用或响应超时，无法启动 Desktop 适配脚本",
      });
    }
  }
  checks.push({
    name: "真实账户与客户端",
    status: "warning",
    detail:
      "本检查不登录、不发送任务。实际账户额度和 Desktop 控件需在运行时核实。",
  });
  return { checkedAt: Date.now(), checks };
}
