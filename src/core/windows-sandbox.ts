import { Rpc } from "./rpc";
// Provision only the unelevated official sandbox, inside the owned profile.
// Never silently replace workspaceWrite with dangerFullAccess on a setup error.
export async function ensureWindowsSandbox(
  rpc: Rpc,
  cwd: string,
  sandbox: string,
) {
  if (process.platform !== "win32" || sandbox === "dangerFullAccess") return;
  const readiness = await rpc.call("windowsSandbox/readiness");
  if (readiness.status === "ready") return;
  let cleanup = () => {};
  const complete = new Promise<void>((resolve, reject) => {
    const handler = (event: any) => {
      cleanup();
      event.success
        ? resolve()
        : reject(
            new Error(`Windows 沙盒配置失败：${event.error ?? "unknown"}`),
          );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Windows 沙盒配置超时"));
    }, 60_000);
    cleanup = () => {
      clearTimeout(timer);
      rpc.off("windowsSandbox/setupCompleted", handler);
    };
    rpc.on("windowsSandbox/setupCompleted", handler);
  });
  // Attach a rejection handler before the request; a fast notification may arrive first.
  const guarded = complete.catch((error) => {
    throw error;
  });
  guarded.catch(() => {});
  try {
    await rpc.call("windowsSandbox/setupStart", { mode: "unelevated", cwd });
    await guarded;
  } finally {
    cleanup();
  }
}
