import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "./store";
const content = z.object({ name: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(100000), model: z.string().max(200), effort: z.string().max(20), planMode: z.boolean(), multiAgent: z.boolean() }).strict();
const item = content.extend({ id: z.string().uuid(), updatedAt: z.number() });
const stateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), items: z.array(item).max(100) }).strict();
export type TaskTemplate = z.infer<typeof item>;
export type TemplateState = z.infer<typeof stateSchema>;
export class Templates {
  private state?: TemplateState;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private write = atomicWrite) {}
  private async load() {
    if (this.state) return this.state;
    const file = path.join(this.root, "task-templates.json");
    try {
      if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw Error("模板文件过大");
      this.state = stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.state = { version: 1, revision: 0, items: [] };
    }
    return this.state;
  }
  async list() { await this.chain.catch(() => {}); return structuredClone(await this.load()); }
  private mutate(fn: (state: TemplateState) => TemplateState) {
    const task = this.chain.catch(() => {}).then(async () => {
      const next = fn(await this.load());
      await this.write(path.join(this.root, "task-templates.json"), JSON.stringify(next, null, 2));
      this.state = next;
      return structuredClone(next);
    });
    this.chain = task;
    return task;
  }
  save(input: unknown) {
    const a = z.object({ revision: z.number().int().nonnegative(), id: z.string().uuid().optional(), template: content }).strict().parse(input);
    return this.mutate((state) => {
      if (a.revision !== state.revision) throw Error("模板列表已变化，请刷新后重试");
      if (a.id && !state.items.some((item) => item.id === a.id)) throw Error("模板已不存在");
      if (!a.id && state.items.length >= 100) throw Error("最多保存 100 个模板");
      const template = { ...a.template, id: a.id || randomUUID(), updatedAt: Date.now() };
      return { ...state, revision: state.revision + 1, items: a.id ? state.items.map((item) => item.id === a.id ? template : item) : [...state.items, template] };
    });
  }
  remove(input: unknown) {
    const a = z.object({ revision: z.number().int().nonnegative(), id: z.string().uuid() }).strict().parse(input);
    return this.mutate((state) => {
      if (a.revision !== state.revision) throw Error("模板列表已变化，请刷新后重试");
      if (!state.items.some((item) => item.id === a.id)) throw Error("模板已不存在");
      return { ...state, revision: state.revision + 1, items: state.items.filter((item) => item.id !== a.id) };
    });
  }
}
