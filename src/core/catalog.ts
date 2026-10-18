import { Rpc, type RpcMessage } from "./rpc";
import type { CatalogLoginUpdate } from "../shared/types";
import { redact } from "./redact";

// OAuth callbacks and MCP connections belong to the app-server process, not to
// one IPC request. Keep it alive until shutdown or a deliberate CLI change.
export class Catalog {
  private rpc?: Rpc;
  private executable?: string;
  private disconnected = false;
  private closing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private logins = new Set<string>();
  constructor(
    private home: string,
    private cli: () => string,
    private loginUpdate: (update: CatalogLoginUpdate) => void = () => {},
    private open: typeof Rpc.open = Rpc.open,
  ) {}

  private failLogins() {
    for (const name of this.logins)
      this.loginUpdate({
        name,
        success: false,
        error: "工具连接已断开，请重新授权",
      });
    this.logins.clear();
  }
  private async connection() {
    const cli = this.cli();
    if (this.rpc && (this.executable !== cli || this.disconnected)) {
      await this.rpc.close(); // A failed close must prevent a competing process.
      this.rpc = undefined;
      this.failLogins();
    }
    if (!this.rpc) {
      const rpc = await this.open(cli, this.home);
      this.rpc = rpc;
      this.executable = cli;
      this.disconnected = false;
      rpc.on("request", (message: RpcMessage) =>
        rpc.reject(message.id!, "请在聊天中完成交互请求"),
      );
      rpc.on("disconnected", () => {
        this.disconnected = true;
        this.failLogins();
      });
      rpc.on("mcpServer/oauthLogin/completed", (value) => {
        if (
          typeof value?.name !== "string" ||
          typeof value.success !== "boolean"
        )
          return;
        this.logins.delete(value.name);
        this.loginUpdate({
          name: value.name,
          success: value.success,
          ...(value.error ? { error: redact(value.error) } : {}),
          ...(value.loginId ? { loginId: value.loginId } : {}),
        });
      });
    }
    return this.rpc;
  }

  operation(
    method: string,
    params: Record<string, unknown>,
    prepare?: (rpc: Rpc) => Promise<void>,
  ) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.closing) throw new Error("正在退出");
        const rpc = await this.connection();
        await prepare?.(rpc);
        const login =
          method === "mcpServer/oauth/login" && typeof params.name === "string"
            ? params.name
            : undefined;
        if (login) this.logins.add(login);
        try {
          const result = await rpc.call(method, params);
          return result === undefined
            ? undefined
            : JSON.parse(redact(JSON.stringify(result)));
        } catch (error) {
          if (login) this.logins.delete(login);
          // Never retry a mutation after a transport failure: its outcome is unknown.
          throw error;
        }
      });
    this.queue = task;
    return task;
  }

  async shutdown() {
    this.closing = true;
    await this.queue.catch(() => {});
    try {
      await this.rpc?.close();
      this.rpc = undefined;
      this.failLogins();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
  resume() {
    this.closing = false;
  }
}

export const localCatalogOperation = (method: string) =>
  /^(skills\/|mcpServerStatus\/|mcpServer\/(oauth\/|resource\/read)|config\/|configRequirements\/|experimentalFeature\/|permissionProfile\/|hooks\/)/.test(
    method,
  );
