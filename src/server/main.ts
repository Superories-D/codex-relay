import { readServerConfig } from "./config";
import { telegramConfig, TelegramBridge } from "./telegram";
import { openHttp } from "./http";
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
      config: { type: "string" },
      cli: { type: "string" },
      check: { type: "boolean" },
      doctor: { type: "boolean" },
      "ipc-port": { type: "string" },
      "http-port": { type: "string" },
      workspace: { type: "string", multiple: true },
      telegram: { type: "boolean" },
      "telegram-config": { type: "string" },
    },
  });
  const config = await readServerConfig(values.config);
  values["data-dir"] ??= config?.dataDir;
  values.cli ??= config?.cli;
  values.workspace ??= config?.workspaces;
  values["http-port"] ??= config?.httpPort?.toString();
  values["ipc-port"] ??= config?.ipcPort?.toString();
  values.telegram ??= config?.telegram;
  const root = path.resolve(
    values["data-dir"] ||
      path.join(os.homedir(), ".local/share/codex-relay-server"),
  );
  const ipcPort =
    values["ipc-port"] === undefined ? undefined : Number(values["ipc-port"]);
  if (
    ipcPort !== undefined &&
    (values["ipc-port"]?.trim() === "" || !Number.isInteger(ipcPort) || ipcPort < 0 || ipcPort > 65535)
  )
    throw Error("Invalid IPC port");
  const httpPort =
    values["http-port"] === undefined ? undefined : Number(values["http-port"]);
  if (
    httpPort !== undefined &&
    (values["http-port"]?.trim() === "" || !Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535)
  )
    throw Error("Invalid HTTP port");
  const runtime = await ServerRuntime.open(root, values.cli);
  let botConfig;
  try {
    if (values.telegram || values["telegram-config"])
      botConfig = await telegramConfig(
        runtime.store.root,
        values["telegram-config"],
      );
    if (values.telegram && !botConfig)
      throw Error(
        "Import a private Telegram config before enabling the bridge",
      );
  } catch (error) {
    await runtime.close();
    throw error;
  }
  if (values.doctor) {
    try {
      const report: any = await runtime.command("environment.check");
      console.log(JSON.stringify(report,null,2));
      if (report.checks.some((c: any) => c.status === "error")) process.exitCode = 1;
    } finally { await runtime.close(); }
    return;
  }
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
  let web: Awaited<ReturnType<typeof openHttp>> | undefined;
  try {
    if (httpPort !== undefined)
      web = await openHttp(
        runtime,
        httpPort,
        values.workspace || [],
        path.join(__dirname, "ui"),
      );
  } catch (error) {
    server.close();
    await runtime.close();
    throw error;
  }
  let bot: TelegramBridge | undefined;
  try {
    if (values.telegram)
      bot = await TelegramBridge.open(
        runtime,
        botConfig!,
        values.workspace || [],
      );
  } catch (error) {
    await web?.close();
    server.close();
    await runtime.close();
    throw error;
  }
  bot?.start((error) =>
    console.error(redact(error instanceof Error ? error.message : error)),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await bot?.stop();
      await runtime.close();
      server.close();
      await web?.close();
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
  if (web)
    console.log(
      `HTTP port: ${(web.server.address() as import("node:net").AddressInfo).port}`,
    );
  if (ipcPort !== undefined)
    console.log(
      `IPC TCP port: ${(server.address() as import("node:net").AddressInfo).port}`,
    );
}
main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
