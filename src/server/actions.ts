import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../core/store";
import { redact } from "../core/redact";
const receiptSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string(),
  action: z.string(),
  jobId: z.string().uuid(),
  at: z.number(),
  state: z.enum(["pending", "succeeded", "uncertain"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ActionReceipt = z.infer<typeof receiptSchema>;
/** A durable intent precedes every non-replayable native operation. Pending after
 * a crash is deliberately NOT replayed: the downstream RPC has no idempotency key. */
export class RemoteActions {
  private active = new Map<string, Promise<ActionReceipt>>();
  constructor(
    private root: string,
    private write = atomicWrite,
  ) {}
  private file(id: string) {
    return path.join(
      this.root,
      "remote-actions",
      z.string().uuid().parse(id) + ".json",
    );
  }
  async read(id: string): Promise<ActionReceipt | null> {
    try {
      return receiptSchema.parse(
        JSON.parse(await fs.readFile(this.file(id), "utf8")),
      );
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async run(
    id: string,
    action: string,
    jobId: string,
    input: unknown,
    effect: () => Promise<unknown>,
  ): Promise<ActionReceipt> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ action, jobId, input }))
      .digest("hex");
    const existing = this.active.get(id);
    if (existing) {
      await existing;
      return this.run(id, action, jobId, input, effect);
    }
    const task = this.perform(id, action, jobId, fingerprint, effect);
    this.active.set(id, task);
    try {
      return await task;
    } finally {
      this.active.delete(id);
    }
  }
  private async perform(
    id: string,
    action: string,
    jobId: string,
    fingerprint: string,
    effect: () => Promise<unknown>,
  ) {
    const file = this.file(id),
      previous = await this.read(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw Error("Request ID already belongs to a different operation");
      return previous;
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const receipt: ActionReceipt = {
      id,
      action,
      jobId,
      fingerprint,
      at: Date.now(),
      state: "pending",
    };
    await this.write(file, JSON.stringify(receipt));
    try {
      receipt.result = await effect();
      receipt.state = "succeeded";
    } catch (error) {
      receipt.state = "uncertain";
      receipt.error = String(
        redact(error instanceof Error ? error.message : String(error)),
      ).slice(0, 2000);
    }
    await this.write(file, JSON.stringify(receipt));
    return receipt;
  }
}
