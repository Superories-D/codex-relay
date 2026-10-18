import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Rpc } from "./rpc";
import { StringDecoder } from "node:string_decoder";
import type { TerminalSession } from "../shared/types";
import { redact } from "./redact";

interface Session extends TerminalSession {
  home: string;
  rpc?: Rpc;
  opening?: Promise<void>;
  closing?: Promise<void>;
  command?: Promise<void>;
  input: Promise<unknown>;
  closeRequested: boolean;
  output: string;
  offset: number;
  decoder: StringDecoder;
}
export class Terminals {
  private sessions = new Map<string, Session>();
  private stopping = false;
  private shutdownTask?: Promise<void>;
  constructor(
    private root: string,
    private cli: () => string,
    private openRpc: typeof Rpc.open = Rpc.open,
  ) {}
  private summary({
    id,
    cwd,
    name,
    state,
    exitCode,
    error,
  }: Session): TerminalSession {
    return { id, cwd, name, state, exitCode, error };
  }
  list() {
    return [...this.sessions.values()].map((session) => this.summary(session));
  }

  async open(cwd: string, cols = 100, rows = 24) {
    if (this.stopping) throw new Error("客户端正在退出，无法新建终端");
    if (this.sessions.size >= 8)
      throw new Error("最多同时打开 8 个终端，请关闭不再使用的终端");
    const id = randomUUID();
    const session: Session = {
      id,
      cwd,
      home: path.join(this.root, "terminals", id),
      name: process.platform === "win32" ? "PowerShell" : "Shell",
      state: "starting",
      output: "",
      offset: 0,
      decoder: new StringDecoder("utf8"),
      input: Promise.resolve(),
      closeRequested: false,
    };
    // Reserve before the first await. Pending starts count toward capacity and
    // are visible to shutdown, even before Rpc.open has returned a process.
    this.sessions.set(id, session);
    session.opening = this.start(session, cols, rows);
    await session.opening;
    if (this.stopping || session.closeRequested)
      throw new Error("终端正在关闭");
    return this.summary(session);
  }
  private async start(session: Session, cols: number, rows: number) {
    const { id, cwd, home } = session;
    try {
      if (!(await fs.stat(cwd)).isDirectory())
        throw new Error("终端目录不存在");
      if (this.stopping || session.closeRequested)
        throw new Error("终端正在关闭");
      const rpc = await this.openRpc(this.cli(), home);
      session.rpc = rpc;
      if (this.stopping || session.closeRequested)
        throw new Error("终端正在关闭");
      rpc.on("request", (message) =>
        rpc.reject(message.id, "终端不接受会话交互请求"),
      );
      rpc.on("command/exec/outputDelta", (p) => {
        if (p.processId !== id) return;
        if (session.state === "starting") session.state = "running";
        this.output(
          session,
          session.decoder.write(Buffer.from(p.deltaBase64, "base64")),
        );
      });
      rpc.on("disconnected", () => {
        if (
          !session.closeRequested &&
          ["starting", "running"].includes(session.state)
        ) {
          session.state = "error";
          session.error = "终端连接已关闭";
        }
      });
      const shell =
        process.platform === "win32"
          ? [
              path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32/WindowsPowerShell/v1.0/powershell.exe",
              ),
              "-NoLogo",
              "-NoProfile",
              "-NoExit",
            ]
          : [process.env.SHELL || "/bin/bash", "-i"];
      session.command = rpc
        .call(
          "command/exec",
          {
            command: shell,
            cwd,
            processId: id,
            tty: true,
            size: { cols, rows },
            disableTimeout: true,
            sandboxPolicy: { type: "dangerFullAccess" },
            env: { PSModulePath: null },
          },
          7 * 24 * 3600000,
        )
        .then((result) => {
          if (!session.closeRequested) {
            session.state = "exited";
            session.exitCode = result.exitCode;
          }
        })
        .catch((error) => {
          if (!session.closeRequested) {
            session.state = "error";
            session.error = redact(error.message);
          }
        })
        .finally(async () => {
          this.output(session, session.decoder.end());
          // Keep the tab/output, release the app-server after the shell exits.
          try {
            await rpc.close();
          } catch (error) {
            session.state = "error";
            session.error = redact(error);
          }
        });
    } catch (error) {
      session.state = "error";
      session.error = redact(error instanceof Error ? error.message : error);
      try {
        if (session.rpc) await session.rpc.close();
        else await Rpc.assertHomeIdle(home);
        this.sessions.delete(id);
      } catch (cleanupError) {
        // Retain failed cleanup so close/shutdown can retry; do not hide a
        // possibly live process or make its capacity slot available again.
        session.error = redact(
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
        throw cleanupError;
      }
      throw error;
    }
  }
  private output(session: Session, text: string) {
    session.output += text;
    if (session.output.length > 1024 * 1024) {
      let trim = session.output.length - 1024 * 1024;
      const code = session.output.charCodeAt(trim);
      if (code >= 0xdc00 && code <= 0xdfff) trim++;
      session.output = session.output.slice(trim);
      session.offset += trim;
    }
  }
  read(id: string, cursor = 0) {
    const session = this.get(id);
    const end = session.offset + session.output.length;
    const reset = cursor < session.offset || cursor > end;
    return {
      text: reset
        ? session.output
        : session.output.slice(cursor - session.offset),
      cursor: end,
      reset,
      state: session.state,
      exitCode: session.exitCode,
      error: session.error,
    };
  }
  write(id: string, text: string) {
    const s = this.get(id);
    const operation = s.input
      .catch(() => {})
      .then(async () => {
        if (s.closeRequested || this.stopping) throw new Error("终端正在关闭");
        if (s.state === "starting") throw new Error("终端正在启动，请稍后输入");
        if (s.state !== "running" || !s.rpc) throw new Error("终端已退出");
        await s.rpc.call("command/exec/write", {
          processId: id,
          deltaBase64: Buffer.from(text).toString("base64"),
        });
      });
    s.input = operation;
    return operation;
  }
  async resize(id: string, cols: number, rows: number) {
    const s = this.get(id);
    if (!s.closeRequested && s.state === "running")
      await s.rpc!.call("command/exec/resize", {
        processId: id,
        size: { cols, rows },
      });
  }
  private get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("终端不存在");
    return s;
  }
  close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve();
    if (s.closing) return s.closing;
    s.closeRequested = true;
    s.state = "closing";
    s.closing = (async () => {
      await s.opening?.catch(() => {});
      if (!this.sessions.has(id)) return;
      if (s.rpc) {
        await s.rpc
          .call("command/exec/terminate", { processId: id }, 5000)
          .catch(() => {});
        await s.rpc.close();
      } else await Rpc.assertHomeIdle(s.home);
      await s.command;
      await s.input.catch(() => {});
      this.sessions.delete(id);
    })()
      .catch((error) => {
        s.state = "error";
        s.error = redact(error instanceof Error ? error.message : error);
        throw error;
      })
      .finally(() => {
        s.closing = undefined;
      });
    return s.closing;
  }
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    this.shutdownTask = (async () => {
      const results = await Promise.allSettled(
        [...this.sessions.keys()].map((id) => this.close(id)),
      );
      const errors = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "仍有终端未能确认停止，请重试关闭",
        );
    })().finally(() => {
      this.shutdownTask = undefined;
    });
    return this.shutdownTask;
  }
  resume() {
    this.stopping = false;
  }
}
