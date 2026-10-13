import WebSocket from "ws";
export class Cdp {
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (x: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(new Error(message.error.message))
        : pending.resolve(message.result);
    });
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("客户端调试连接已关闭"));
      }
      this.pending.clear();
    };
    ws.on("close", fail);
    ws.on("error", fail);
  }
  static async connect(port: number): Promise<Cdp> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid local CDP port");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
    const pages = ((await response.json()) as any[]).filter(
      (p) =>
        p.type === "page" &&
        p.webSocketDebuggerUrl &&
        !/^devtools:/.test(p.url),
    );
    if (pages.length !== 1) throw new Error("无法唯一定位受管客户端页面");
    const url = new URL(pages[0].webSocketDebuggerUrl);
    if (
      url.protocol !== "ws:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      Number(url.port) !== port
    )
      throw new Error("CDP 地址不属于受管本机端口");
    const ws = new WebSocket(url.toString());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("CDP handshake timed out"));
      }, 5000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    return new Cdp(ws);
  }
  call(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("客户端适配脚本执行失败");
    return result.result.value as T;
  }
  async click(selector: string): Promise<boolean> {
    return this.evaluate(
      `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(x => x.getClientRects().length && !x.disabled); if(e.length !== 1) return false; e[0].click(); return true; })()`,
    );
  }
  async selectThread(selector: string, title: string): Promise<boolean> {
    return this.evaluate(`(() => {
      let e = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(x => x.getClientRects().length);
      if (!e.length) e = [...document.querySelectorAll('a,button,[role="button"]')].filter(x => x.getClientRects().length && (x.textContent.trim() === ${JSON.stringify(title)} || x.getAttribute('title') === ${JSON.stringify(title)}));
      if(e.length !== 1) return false; e[0].click(); return true;
    })()`);
  }
  async fill(selector: string, text: string) {
    const focused = await this.evaluate<boolean>(`(() => {
      const e = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(x => x.getClientRects().length && !x.disabled);
      if(e.length !== 1 || (e[0].value ?? e[0].textContent).trim()) return false;
      e[0].focus(); return document.activeElement === e[0];
    })()`);
    if (!focused) throw new Error("未找到唯一的空白输入框，保留现有草稿");
    await this.call("Input.insertText", { text });
    const matched = await this.evaluate<boolean>(
      `(() => { const e=document.activeElement; return (e.value ?? e.textContent) === ${JSON.stringify(text)}; })()`,
    );
    if (!matched) throw new Error("输入校验失败，未发送任务");
  }
  close() {
    this.ws.close();
  }
}
