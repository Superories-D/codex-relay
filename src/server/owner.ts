import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
// Linux flock is held by a tiny child until the supervisor pipe closes. Kernel
// locks release on crashes, without trusting stale PID files or racing unlink.
export async function acquireOwner(root: string) {
  const child = spawn(
    "flock",
    [
      "-n",
      path.join(root, "server.lock"),
      process.execPath,
      "-e",
      "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let released = false,
    lost: () => void = () => {};
  const exit = once(child, "exit").catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Server lock timed out"));
    }, 5000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Data directory is already owned by another server"));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("LOCKED\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.once("exit", () => {
    if (!released) lost();
  });
  return {
    onLost(fn: () => void) {
      lost = fn;
      if (child.exitCode !== null) fn();
    },
    async release() {
      released = true;
      child.stdin.end();
      await exit;
    },
  };
}
