import {serverHeaders} from "./identity";
export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request(token: string, name: string, args?: unknown) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...serverHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(60000),
    redirect:"error",
  });
  const value = await response.json();
  if (!response.ok)
    throw new CommandError(
      response.status,
      value.error || `HTTP ${response.status}`,
    );
  return value.result;
}
export async function watch(
  token: string,
  signal: AbortSignal,
  onSnapshot: (value: any) => void,
  onStatus: (status: string) => void,
) {
  let attempt = 0;
  while (!signal.aborted) {
    const connection = new AbortController();
    let idle: ReturnType<typeof setTimeout>;
    // The daemon sends heartbeat comments every 15 seconds. Half-open proxies
    // can keep a fetch alive forever, so bound both headers and stream silence.
    const heartbeat = () => {
      clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), 45000);
    };
    heartbeat();
    try {
      onStatus(attempt ? "重新连接中" : "正在连接");
      const response = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${token}`, ...serverHeaders() },
        signal: AbortSignal.any([signal, connection.signal]),
        redirect:"error",
      });
      if (response.status === 409) {
        onStatus("服务器身份已变化，请在新标签页连接；本页保留原服务器的待确认请求。");return;
      }
      if (response.status === 401) {
        onStatus("令牌无效，请重新连接");
        return;
      }
      if (!response.ok || !response.body)
        throw Error("Status stream unavailable");
      onStatus("已连接");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          heartbeat();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 32 * 1024 * 1024)
            throw Error("Status frame too large");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (data) {
              onSnapshot(JSON.parse(data.slice(6)));
              attempt = 0;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      if (signal.aborted) return;
    } finally {
      clearTimeout(idle!);
      connection.abort();
    }
    if (signal.aborted) return;
    onStatus("重新连接中");
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(
        done,
        Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)),
      );
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
