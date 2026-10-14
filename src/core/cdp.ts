import WebSocket from "ws";
import type { Settings } from "../shared/types";
// Executed inside the owned page. Route IDs match complete segments, never substrings.
const dom = `
 const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
 const usable = e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
 const elements = selector => [...document.querySelectorAll(selector)].filter(visible);
 const matchesRoute = (route,id) => { try { const hash=route.indexOf('#'); const pathname=route.split(/[?#]/,1)[0]; const fragment=hash>=0?route.slice(hash+1).split('?',1)[0]:''; return decodeURIComponent(pathname+'/'+fragment).split('/').includes(id); } catch { return false; } };
 const selected = (id,selector) => {
   if(matchesRoute(location.pathname+location.search+location.hash,id)) return true;
   const e=elements(selector);
   return e.length===1 && (['true','page'].includes(e[0].getAttribute('aria-current')) || e[0].getAttribute('aria-selected')==='true' || e[0].getAttribute('data-state')==='active');
 };
 const content = e => String(e.value ?? e.innerText ?? e.textContent ?? '').replace(/\\r\\n/g,'\\n').replace(/\\n$/,'');
`;
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
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
    if (!response.ok) throw new Error("客户端调试端口未就绪");
    const pages = ((await response.json()) as any[]).filter(
      (p) =>
        p.type === "page" &&
        p.webSocketDebuggerUrl &&
        !/^devtools:/.test(p.url),
    );
    if (pages.length !== 1)
      throw new Error(
        `受管客户端有 ${pages.length} 个候选页面，无法唯一定位；请关闭该实例内多余窗口`,
      );
    const url = new URL(pages[0].webSocketDebuggerUrl);
    if (
      url.protocol !== "ws:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      Number(url.port) !== port
    )
      throw new Error("CDP 地址不属于受管本机端口");
    const ws = new WebSocket(url.toString(), { maxPayload: 4 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("客户端调试连接超时"));
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
    if (this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("客户端调试连接已关闭"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("客户端正在处理其他操作，请稍后"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`客户端响应超时：${method}`)),
        8000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error as Error);
      }
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error("客户端选择器或适配脚本执行失败，请在设置中检查选择器");
    return result.result.value as T;
  }
  click(selector: string): Promise<boolean> {
    return this.evaluate(
      `(()=>{${dom}const e=elements(${JSON.stringify(selector)}).filter(usable);if(e.length!==1)return false;e[0].click();return true})()`,
    );
  }
  selectThread(
    selector: string,
    title: string,
    threadId?: string,
  ): Promise<boolean> {
    return this.evaluate(`(()=>{${dom}
      let e=elements(${JSON.stringify(selector)}).filter(usable);
      if(!e.length && ${JSON.stringify(threadId ?? "")}) e=[...document.querySelectorAll('a[href]')].filter(x=>usable(x)&&matchesRoute(x.getAttribute('href'),${JSON.stringify(threadId ?? "")}));
      if(!e.length)e=[...document.querySelectorAll('a,button,[role="button"]')].filter(x=>usable(x)&&(x.textContent.trim()===${JSON.stringify(title)}||x.getAttribute('title')===${JSON.stringify(title)}));
      if(e.length!==1)return false;e[0].click();return true;
    })()`);
  }
  isThreadSelected(threadId: string, selector: string): Promise<boolean> {
    return this.evaluate(
      `(()=>{${dom}return selected(${JSON.stringify(threadId)},${JSON.stringify(selector)})})()`,
    );
  }
  async fill(selector: string, text: string) {
    const result = await this.evaluate<string>(`(()=>{${dom}
      const e=elements(${JSON.stringify(selector)}).filter(usable);if(e.length!==1||e[0].readOnly)return 'blocked';
      if(content(e[0])===${JSON.stringify(text.replace(/\r\n/g, "\n").replace(/\n$/, ""))})return 'same';
      if(content(e[0]).trim())return 'blocked';e[0].focus();return document.activeElement===e[0]?'insert':'blocked';
    })()`);
    if (result === "same") return;
    if (result !== "insert")
      throw new Error("未找到唯一的空白输入框，保留现有草稿");
    await this.call("Input.insertText", { text });
    const matched = await this.evaluate<boolean>(
      `(()=>{${dom}return content(document.activeElement)===${JSON.stringify(text.replace(/\r\n/g, "\n").replace(/\n$/, ""))}})()`,
    );
    if (!matched) throw new Error("输入校验失败，未发送任务");
  }
  // Recheck route, draft and button atomically in one renderer invocation.
  clickForThread(
    selector: string,
    threadId: string,
    threadSelector: string,
    draft?: { selector: string; text: string },
  ): Promise<boolean> {
    return this.evaluate(`(()=>{${dom}
      if(!selected(${JSON.stringify(threadId)},${JSON.stringify(threadSelector)}))return false;
      ${draft ? `const input=elements(${JSON.stringify(draft.selector)}).filter(usable);if(input.length!==1||content(input[0])!==${JSON.stringify(draft.text.replace(/\r\n/g, "\n").replace(/\n$/, ""))})return false;` : ""}
      const e=elements(${JSON.stringify(selector)}).filter(usable);if(e.length!==1)return false;e[0].click();return true;
    })()`);
  }
  inspect(selectors: Settings["desktop"], threadId: string) {
    const threadSelector = selectors.threadSelector.replaceAll(
      "{threadId}",
      threadId,
    );
    return this.evaluate(`(()=>{${dom}
      const counts={};for(const [key,selector] of Object.entries(${JSON.stringify({ ...selectors, threadSelector })})){if(selector)counts[key]=elements(selector).filter(usable).length;}
      const input=elements(${JSON.stringify(selectors.editorSelector)});
      return {connected:true,threadSelected:selected(${JSON.stringify(threadId)},${JSON.stringify(threadSelector)}),counts,hasDraft:input.length===1&&!!content(input[0]).trim()};
    })()`);
  }
  close() {
    this.ws.terminate();
  }
}
