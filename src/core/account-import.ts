import { randomUUID } from "node:crypto";
import { Accounts, parseAuth } from "./accounts";
import type { Store } from "./store";
import { redact } from "./redact";

const clean = (value: unknown, max = 100) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, "")
        .trim()
        .slice(0, max)
    : "";
interface Entry {
  index: number;
  label: string;
  email: string;
  plan: string;
  identity?: string;
  auth?: ReturnType<typeof parseAuth>["auth"];
  error?: string;
  duplicate?: boolean;
}
export interface ImportPreview {
  id: string;
  expiresAt: number;
  rows: {
    index: number;
    label: string;
    email: string;
    plan: string;
    action: "add" | "update" | "skip";
    error?: string;
  }[];
}
export function parseImport(text: string): Entry[] {
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
    throw new Error("导入文件超过 2 MiB");
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("导入文件为空");
  let values: unknown[];
  try {
    const value = JSON.parse(source);
    values = Array.isArray(value)
      ? value
      : Array.isArray(value?.accounts)
        ? value.accounts
        : [value];
  } catch {
    const lines = source.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 200) throw new Error("一次最多导入 200 条账户");
    values = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  }
  if (!values.length || values.length > 200)
    throw new Error("导入内容应包含 1–200 条账户");
  const seen = new Set<string>();
  return values.map((value, index) => {
    const row: Entry = {
      index,
      label: `账户 ${index + 1}`,
      email: "",
      plan: "",
    };
    try {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("该条不是有效的 JSON 账户对象");
      const v = value as any;
      row.label = clean(v.label ?? v.name) || row.label;
      if (
        v.api_key ||
        v.OPENAI_API_KEY ||
        (v.auth_mode && !["chatgpt", "chatgptAuthTokens"].includes(v.auth_mode))
      )
        throw new Error(
          "只导入 ChatGPT 订阅账户，不支持 API Key 或其他认证类型",
        );
      if (v.deleted_at || v.deletedAt || v.status === "deleted")
        throw new Error("该账户在原备份中已删除，默认跳过");
      const tokens = v.tokens ?? v.credentials ?? v;
      if (!tokens || typeof tokens !== "object")
        throw new Error("缺少 OAuth 凭据");
      if (tokens.api_key || tokens.OPENAI_API_KEY)
        throw new Error("不支持 API Key 凭据");
      const topIdentity = v.account_id ?? v.chatgpt_account_id;
      if (topIdentity && tokens.account_id && topIdentity !== tokens.account_id)
        throw new Error("账户身份字段冲突，拒绝混合凭据");
      const parsed = parseAuth(
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: tokens.access_token,
            id_token: tokens.id_token,
            refresh_token: tokens.refresh_token,
            account_id:
              tokens.account_id ?? tokens.chatgpt_account_id ?? topIdentity,
          },
          last_refresh:
            typeof v.last_refresh === "string" ? v.last_refresh : undefined,
        }),
      );
      row.identity = parsed.identity;
      row.email = parsed.email;
      row.plan = parsed.plan;
      if (!clean(v.label ?? v.name)) row.label = parsed.email;
      if (seen.has(parsed.identity)) {
        row.duplicate = true;
        row.error = "同一文件内重复账户，已保留第一条";
        return row;
      }
      seen.add(parsed.identity);
      row.auth = parsed.auth;
    } catch (error) {
      row.error = error instanceof Error ? error.message : "无法解析该条账户";
    }
    return row;
  });
}

// Credentials remain in the main process, never in a renderer snapshot or preview.
export class AccountImport {
  private pending?: { id: string; expiresAt: number; entries: Entry[] };
  private timer?: NodeJS.Timeout;
  private committing = false;
  private batchDone?: Promise<void>;
  constructor(
    private accounts: Accounts,
    private store: Store,
  ) {}
  preview(text: string, now = Date.now()): ImportPreview {
    if (this.committing) throw new Error("账户导入仍在进行");
    this.cancel();
    const entries = parseImport(text);
    const id = randomUUID(),
      expiresAt = now + 10 * 60_000;
    this.pending = { id, expiresAt, entries };
    this.timer = setTimeout(() => this.cancel(), 10 * 60_000);
    this.timer.unref?.();
    return {
      id,
      expiresAt,
      rows: entries.map((row) => ({
        index: row.index,
        label: row.label,
        email: row.email,
        plan: row.plan,
        error: row.error,
        action: !row.auth
          ? "skip"
          : this.store.data.accounts.some((a) => a.identity === row.identity)
            ? "update"
            : "add",
      })),
    };
  }
  cancel(id?: string) {
    if (id && this.pending?.id !== id) return;
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async drain() {
    this.cancel();
    // Wait for the whole batch, including gaps between per-account locks.
    // The application rejects new commands before calling this during quit.
    await this.batchDone;
  }
  async commit(id: string, indices: number[]) {
    const batch = this.pending;
    if (
      this.committing ||
      !batch ||
      batch.id !== id ||
      batch.expiresAt <= Date.now()
    )
      throw new Error("导入预览已失效，请重新选择文件");
    if (
      !indices.length ||
      indices.length > 200 ||
      new Set(indices).size !== indices.length ||
      indices.some((i) => !Number.isInteger(i) || !batch.entries[i]?.auth)
    )
      throw new Error("请选择有效且不重复的账户");
    this.committing = true;
    let finished!: () => void;
    this.batchDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.cancel(id);
    const results: {
      index: number;
      label: string;
      ok: boolean;
      error?: string;
    }[] = [];
    try {
      for (const index of indices) {
        const row = batch.entries[index];
        try {
          await this.accounts.import(JSON.stringify(row.auth), row.label);
          results.push({ index, label: row.label, ok: true });
        } catch (error) {
          results.push({
            index,
            label: row.label,
            ok: false,
            error: redact(error instanceof Error ? error.message : "导入失败"),
          });
        }
        row.auth = undefined;
      }
      return { imported: results.filter((r) => r.ok).length, results };
    } finally {
      for (const row of batch.entries) row.auth = undefined;
      this.committing = false;
      finished();
      this.batchDone = undefined;
    }
  }
}
