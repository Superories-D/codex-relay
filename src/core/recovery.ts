import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Job } from "../shared/types";
import { Accounts, parseAuth, matchesAuth } from "./accounts";
import { Store } from "./store";
import { Rpc } from "./rpc";
import { windowsPowerShellEnv } from "./powershell";
// A crash never authorizes a second writer. Recovery is invoked by the explicit
// Continue / Cancel control; the entire queue stays frozen until it succeeds.
export async function recoverJob(
  job: Job,
  store: Store,
  accounts: Accounts,
  scripts: string,
) {
  const home = store.jobHome(job.id);
  await Rpc.assertHomeIdle(home);
  await Rpc.assertHomeIdle(path.join(home, "quota-probe"));
  if (job.accountId) await Rpc.assertHomeIdle(store.profileHome(job.accountId));
  if (job.mode !== "desktop") return;
  let request: any;
  try {
    request = JSON.parse(
      (
        await fs.readFile(path.join(home, "desktop-launch.json"), "utf8")
      ).replace(/^\uFEFF/, ""),
    );
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (request) {
    const receiptPath = path.join(home, "desktop-receipt.json");
    let receipt: any;
    try {
      receipt = JSON.parse(
        (await fs.readFile(receiptPath, "utf8")).replace(/^\uFEFF/, ""),
      );
    } catch {
      throw new Error(
        "上次客户端启动没有可靠回执。请核查受管客户端进程及 desktop-launch.json / desktop-receipt.json，暂不自动恢复。",
      );
    }
    if (receipt.nonce !== request.nonce)
      throw new Error("客户端恢复回执不匹配");
    if (receipt.started !== false) {
      if (process.platform !== "win32")
        throw new Error("请在 Windows 上恢复客户端任务");
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
          path.join(scripts, "desktop-control.ps1"),
          "-RequestPath",
          receiptPath,
          "-Action",
          "stop",
        ],
        { windowsHide: true, timeout: 20_000, env: windowsPowerShellEnv() },
      );
    }
  }
  if (!job.accountId) return;
  try {
    const auth = parseAuth(
      await fs.readFile(path.join(home, "auth.json"), "utf8"),
    ).auth;
    if (
      !matchesAuth(
        store.data.accounts.find((a) => a.id === job.accountId),
        auth,
      )
    )
      throw new Error("恢复凭据的账户身份不匹配");
    await accounts.put(job.accountId, auth);
    await fs.rm(path.join(home, "auth.json"), { force: true });
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  accounts.busy.delete(job.accountId);
}
