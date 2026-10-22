import React, { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { CopyButton } from "./CopyButton";
import { t, useI18n, formatDate, errorText } from "./i18n";
import type { ChatItem } from "../shared/types";
type Result = { items: { id: string; role: ChatItem["role"]; at: number; excerpt: string }[]; total: number; next?: number };
export function ChatSearch({ id, call, close }: { id: string; call: (name: string, args?: unknown) => Promise<any>; close: () => void }) {
  useI18n();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<Result>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<{ text: string; detail?: string; truncated?: boolean }>();
  useEffect(() => {
    let current = true;
    setSelected(""); setDetail(undefined); setError("");
    if (!query.trim()) { setResult({ items: [], total: 0 }); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void call("chat.search", { id, query: query.trim(), offset, ...(role ? { role } : {}) })
        .then((value) => { if (current) setResult(value); })
        .catch((e) => { if (current) setError(errorText(e)); })
        .finally(() => { if (current) setLoading(false); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [id, query, role, offset]);
  useEffect(() => {
    let current = true; setDetail(undefined);
    if (selected) void call("chat.searchItem", { id, itemId: selected })
      .then((value) => { if (current) setDetail(value); })
      .catch((e) => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [id, selected]);
  const labels = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
  return <Dialog title={t("搜索会话内容")} onClose={close}>
    <div className="chat-search">
      <input autoFocus aria-label={t("搜索会话内容")} value={query} maxLength={200} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder={t("搜索消息、代码或工具输出")} />
      <select aria-label={t("消息角色")} value={role} onChange={(e) => { setRole(e.target.value); setOffset(0); }}>
        <option value="">{t("全部角色")}</option>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
      {error && <p role="alert">{error}</p>}
      <p role="status">{loading ? t("正在搜索…") : t("找到 {count} 条消息", { count: result.total })}</p>
      <div className="search-results">{!loading && result.items.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}>
        <small>{t(labels[item.role])} · {formatDate(item.at)}</small><span>{item.excerpt}</span>
      </button>)}</div>
      <div className="queue-actions"><button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>{t("上一页")}</button><button disabled={loading || result.next === undefined} onClick={() => setOffset(result.next!)}>{t("下一页")}</button></div>
      {detail && <section className="search-detail"><CopyButton text={[detail.text, detail.detail].filter(Boolean).join("\n\n")} label={t("复制")} /><pre>{detail.text}</pre>{detail.detail && <pre>{detail.detail}</pre>}{detail.truncated && <p>{t("内容较长，仅显示前段，请导出会话查看完整内容。")}</p>}</section>}
    </div>
  </Dialog>;
}
