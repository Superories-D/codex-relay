import type { FileHandle } from "node:fs/promises";
// Sequential callers batch small JSONL records into bounded writes.
export class TextWriter {
  private pending = "";
  constructor(private file: FileHandle) {}
  async write(text: string) {
    this.pending += text;
    if (this.pending.length >= 65536) await this.flush();
  }
  async flush() {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    await this.file.writeFile(text);
  }
}
