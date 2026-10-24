import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "../core/store";
import { deliveryPlanContent, deliveryPlanStateSchema, type DeliveryPlanState } from "../shared/delivery-center";

// Separate from prompt templates: an acceptance plan can be applied to many
// different tasks without replacing their prompt, model or conversation draft.
export class DeliveryPlans {
  private state?: DeliveryPlanState;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private write = atomicWrite) {}
  private get file() {return path.join(this.root, "delivery-plans.json");}
  private async load() {
    if (this.state) return this.state;
    try {return this.state = deliveryPlanStateSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("验收方案文件无法读取；原文件未被覆盖。");
      return this.state = {version: 1, revision: 0, items: []};
    }
  }
  async list() {await this.chain; return structuredClone(await this.load());}
  async drain() {await this.chain;}
  private mutate(fn: (state: DeliveryPlanState) => DeliveryPlanState) {
    const task = this.chain.then(async () => {
      const next = fn(await this.load());
      await this.write(this.file, JSON.stringify(next, null, 2));
      this.state = next; return structuredClone(next);
    });
    this.chain = task.catch(() => {}); return task;
  }
  save(input: unknown) {
    const value = z.object({revision: z.number().int().nonnegative(), id: z.string().uuid().optional(),
      plan: deliveryPlanContent}).strict().parse(input);
    return this.mutate(state => {
      if (state.revision !== value.revision) throw Error("验收方案已更改，请刷新后重试。");
      if (value.id && !state.items.some(p => p.id === value.id)) throw Error("验收方案不存在");
      if (!value.id && state.items.length >= 100) throw Error("最多保存 100 个验收方案");
      const item = {...value.plan, id: value.id ?? randomUUID(), updatedAt: Date.now()};
      return {...state, revision: state.revision + 1,
        items: value.id ? state.items.map(p => p.id === value.id ? item : p) : [...state.items, item]};
    });
  }
  remove(input: unknown) {
    const value = z.object({revision: z.number().int().nonnegative(), id: z.string().uuid()}).strict().parse(input);
    return this.mutate(state => {
      if (state.revision !== value.revision) throw Error("验收方案已更改，请刷新后重试。");
      if (!state.items.some(p => p.id === value.id)) throw Error("验收方案不存在");
      return {...state, revision: state.revision + 1, items: state.items.filter(p => p.id !== value.id)};
    });
  }
}
