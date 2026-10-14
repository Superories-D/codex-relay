// Bound incomplete protocol frames before parsing; readline alone retains an
// unlimited unterminated line. Decode only complete UTF-8 frames.
export class JsonLines {
  private parts: Buffer[] = [];
  private bytes = 0;
  constructor(private limit = 8 * 1024 * 1024) {}
  push(chunk: Buffer, accept: (line: string) => void) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.bytes += part.length;
      if (this.bytes > this.limit) {
        this.parts = [];
        this.bytes = 0;
        throw new Error("Codex 协议帧过大，连接已停止");
      }
      this.parts.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(this.parts, this.bytes).toString("utf8");
      this.parts = [];
      this.bytes = 0;
      if (line.trim()) accept(line);
      start = newline + 1;
    }
  }
}
