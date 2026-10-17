import { EventEmitter } from "node:events";
import { JsonLines } from "./json-lines";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnCodex, terminateTree } from "./process";
import { redact } from "./redact";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "./store";
import { ProcessSafetyError } from "./process-safety-error";
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}
export class RpcError extends Error {
  constructor(readonly detail: any) {
    super(redact(detail.message));
  }
}
export class Rpc extends EventEmitter {
  private sequence = 1;
  private pending = new Map<
    number | string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private dead = false;
  private closing = false;
  private closeInFlight?: Promise<void>;
  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private home: string,
    private nonce: string,
  ) {
    super();
    const frames = new JsonLines();
    const receive = (line: string) => {
      if (line.length > 8 * 1024 * 1024) {
        this.emit("diagnostic", "RPC frame too large");
        return;
      }
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("diagnostic", redact(line));
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          msg.error
            ? pending.reject(new RpcError(msg.error))
            : pending.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) this.emit("request", msg);
      else if (msg.method) {
        this.emit("notification", msg);
        // EventEmitter reserves "error": wire errors are ordinary protocol data.
        this.emit(
          msg.method === "error" ? "rpc:error" : msg.method,
          msg.params,
        );
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.dead) return;
      try {
        frames.push(chunk, receive);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    child.stderr.on("data", (chunk) =>
      this.emit("diagnostic", redact(chunk.toString())),
    );
    child.once("error", (error) => this.fail(error));
    child.once("close", (code) => {
      this.fail(new Error(`Codex app-server exited (${code})`));
    });
    child.stdin.on("error", (error) => this.fail(error));
  }
  private fail(error: Error) {
    const firstFailure = !this.dead;
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (firstFailure && !this.closing) this.emit("disconnected", error);
  }
  static async open(
    cli: string,
    home: string,
    initializeTimeoutMs = 30000,
  ): Promise<Rpc> {
    await Rpc.assertHomeIdle(home);
    const nonce = randomUUID();
    const rpc = new Rpc(
      await spawnCodex(
        cli,
        [
          "-c",
          'cli_auth_credentials_store="file"',
          "-c",
          "features.secret_auth_storage=false",
          "app-server",
        ],
        home,
      ),
      home,
      nonce,
    );
    try {
      if (rpc.child.pid)
        await atomicWrite(
          path.join(home, "relay-owner.json"),
          JSON.stringify({ pid: rpc.child.pid, nonce }),
        );
      await rpc.call(
        "initialize",
        {
          clientInfo: {
            name: "codex_relay",
            title: "Codex Relay",
            version: "0.6.0",
          },
          capabilities: { experimentalApi: true },
        },
        initializeTimeoutMs,
      );
      rpc.notify("initialized", {});
      return rpc;
    } catch (error) {
      try {
        await rpc.close();
      } catch (cleanupError) {
        throw new ProcessSafetyError(
          "初始化失败且未能确认 Codex 进程已停止",
          cleanupError,
        );
      }
      throw error;
    }
  }
  static async assertHomeIdle(home: string) {
    let owner: any;
    try {
      owner = JSON.parse(
        await fs.readFile(path.join(home, "relay-owner.json"), "utf8"),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return;
      throw new Error("受管进程记录损坏，请核查该目录后再继续");
    }
    if (!Number.isInteger(owner.pid) || owner.pid < 1)
      throw new Error("无效的受管进程记录");
    try {
      process.kill(owner.pid, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") {
        await fs.rm(path.join(home, "relay-owner.json"), { force: true });
        return;
      }
      throw error;
    }
    throw new Error(`受管目录仍被进程 ${owner.pid} 使用；不会启动重复实例`);
  }
  send(msg: RpcMessage) {
    if (this.dead || this.child.stdin.destroyed)
      throw new Error("RPC connection is closed");
    if (this.child.stdin.writableLength > 2 * 1024 * 1024)
      throw new Error("Codex 输入管道繁忙，请等待当前操作结束");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  call(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    if (this.pending.size >= 128)
      return Promise.reject(new Error("Codex 待处理请求过多，暂停提交新请求"));
    return new Promise((resolve, reject) => {
      const id = this.sequence++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown) {
    this.send({ method, params });
  }
  respond(id: number | string, result: unknown) {
    this.send({ id, result });
  }
  reject(id: number | string, message: string) {
    this.send({ id, error: { code: -32601, message } });
  }
  close(): Promise<void> {
    if (!this.closeInFlight)
      this.closeInFlight = this.closeOnce().catch((error) => {
        this.closeInFlight = undefined;
        throw error;
      });
    return this.closeInFlight;
  }
  private async closeOnce() {
    this.closing = true;
    await terminateTree(this.child);
    this.fail(new Error("RPC closed"));
    try {
      const file = path.join(this.home, "relay-owner.json");
      const owner = JSON.parse(await fs.readFile(file, "utf8"));
      if (owner.nonce === this.nonce) await fs.rm(file, { force: true });
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
