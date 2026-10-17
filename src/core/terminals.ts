import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Rpc } from "./rpc";
import { StringDecoder } from "node:string_decoder";

interface Session {
  id: string;
  cwd: string;
  name: string;
  rpc: Rpc;
  output: string;
  offset: number;
  state: "running" | "exited" | "error";
  exitCode?: number;
  decoder: StringDecoder;
}
export class Terminals {
  private sessions = new Map<string, Session>();
  constructor(
    private root: string,
    private cli: () => string,
  ) {}
  list() {
    return [...this.sessions.values()].map(
      ({ id, cwd, name, state, exitCode }) => ({
        id,
        cwd,
        name,
        state,
        exitCode,
      }),
    );
  }
  async open(cwd: string, cols = 100, rows = 24) {
    if (this.sessions.size >= 8)
      throw new Error("最多同时打开 8 个终端，请关闭不再使用的终端");
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("终端目录不存在");
    const id = randomUUID(),
      home = path.join(this.root, "terminals", id);
    const rpc = await Rpc.open(this.cli(), home);
    const session: Session = {
      id,
      cwd,
      name: process.platform === "win32" ? "PowerShell" : "Shell",
      rpc,
      output: "",
      offset: 0,
      state: "running",
      decoder: new StringDecoder("utf8"),
    };
    this.sessions.set(id, session);
    rpc.on("command/exec/outputDelta", (p) => {
      if (p.processId === id)
        this.output(
          session,
          session.decoder.write(Buffer.from(p.deltaBase64, "base64")),
        );
    });
    rpc.on("disconnected", () => {
      if (session.state === "running") {
        session.state = "error";
        this.output(session, "\r\n终端连接已关闭。\r\n");
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
    void rpc
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
        session.state = "exited";
        session.exitCode = result.exitCode;
        this.output(session, `\r\n[进程已退出，代码 ${result.exitCode}]\r\n`);
      })
      .catch((e) => {
        session.state = "error";
        this.output(session, `\r\n${e.message}\r\n`);
      });
    return { id, cwd, name: session.name, state: session.state };
  }
  private output(session: Session, text: string) {
    session.output += text;
    if (session.output.length > 1024 * 1024) {
      const trim = session.output.length - 1024 * 1024;
      session.output = session.output.slice(trim);
      session.offset += trim;
    }
  }
  read(id: string, cursor = 0) {
    const session = this.get(id);
    return {
      text: session.output.slice(Math.max(0, cursor - session.offset)),
      cursor: session.offset + session.output.length,
      reset: cursor < session.offset,
      state: session.state,
      exitCode: session.exitCode,
    };
  }
  async write(id: string, text: string) {
    const s = this.get(id);
    if (s.state !== "running") throw new Error("终端已退出");
    await s.rpc.call("command/exec/write", {
      processId: id,
      deltaBase64: Buffer.from(text).toString("base64"),
    });
  }
  async resize(id: string, cols: number, rows: number) {
    const s = this.get(id);
    if (s.state === "running")
      await s.rpc.call("command/exec/resize", {
        processId: id,
        size: { cols, rows },
      });
  }
  private get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("终端不存在");
    return s;
  }
  async close(id: string) {
    const s = this.get(id);
    if (s.state === "running")
      await s.rpc
        .call("command/exec/terminate", { processId: id })
        .catch(() => {});
    await s.rpc.close();
    this.sessions.delete(id);
  }
  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
