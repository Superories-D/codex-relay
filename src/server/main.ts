import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ServerRuntime } from "./runtime";
import { startCommandServer } from "../main/ipc-server";
import { redact } from "../core/redact";
async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      cli: { type: "string" },
      check: { type: "boolean" },
      "ipc-port": { type: "string" },
    },
  });
  const root = path.resolve(
    values["data-dir"] ||
      path.join(os.homedir(), ".local/share/codex-relay-server"),
  );
  const ipcPort =
    values["ipc-port"] === undefined ? undefined : Number(values["ipc-port"]);
  if (
    ipcPort !== undefined &&
    (!Number.isInteger(ipcPort) || ipcPort < 0 || ipcPort > 65535)
  )
    throw Error("Invalid IPC port");
  const runtime = await ServerRuntime.open(root, values.cli);
  if (values.check) {
    await runtime.close();
    console.log("Server data, encryption and ownership checks passed");
    return;
  }
  let server;
  try {
    server = await startCommandServer(
      root,
      runtime.scheduler,
      (name, args) => runtime.command(name, args),
      ["account.importText", "account.list", "approval.list", "chat.send"],
      ipcPort,
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      server.close();
      console.log("Server stopped; runnable tasks will resume on restart");
      process.exit(0);
    } catch (error) {
      stopping = false;
      console.error(redact(error));
    }
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  runtime.start((error) => console.error(redact(error)));
  console.log(`Codex Relay server ready. Data: ${root}`);
  if (ipcPort !== undefined)
    console.log(
      `IPC TCP port: ${(server.address() as import("node:net").AddressInfo).port}`,
    );
}
main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
