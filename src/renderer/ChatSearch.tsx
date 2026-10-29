import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Dialog } from "./Dialog";
import { CopyButton } from "./CopyButton";
import { t, useI18n, formatDate, errorText } from "./i18n";
import { searchContext, searchPageValue, textMatches, type SearchPage } from "./conversation-search";
import "./search-activity.css";
const labels = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
function Highlight({text, query, active = -1}: {text: string; query: string; active?: number}) {
  const {matches} = useMemo(() => textMatches(text, query), [text, query]);
  let at = 0;
  const result: React.ReactNode[] = [];
  matches.forEach((match, index) => {
    result.push(text.slice(at, match.start), <mark key={index} data-search-hit={index} data-active={index === active}>{text.slice(match.start, match.end)}</mark>);
    at = match.end;
  });
  result.push(text.slice(at));
  return <>{result}</>;
}
export function ChatSearch({id, call, close}: {id: string; call: (name: string, args?: unknown) => Promise<any>; close: () => void}) {
  useI18n();
  const callRef = useRef(call); callRef.current = call;
  const [query, setQuery] = useState(""), [role, setRole] = useState("");
  const [offsets, setOffsets] = useState([0]), [pageIndex, setPageIndex] = useState(0);
  const offset = offsets[pageIndex] || 0, context = searchContext(id, query, role, offset);
  const [loaded, setLoaded] = useState<{context: string; value: SearchPage}>();
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<{key: string; text: string; detail?: string; truncated?: boolean}>();
  const [detailError, setDetailError] = useState(""), [detailLoading, setDetailLoading] = useState(false);
  const [retry, setRetry] = useState(0), [detailRetry, setDetailRetry] = useState(0), [hit, setHit] = useState(0);
  const chooseEdge = useRef<"first" | "last">("first"), list = useRef<HTMLDivElement>(null), detailView = useRef<HTMLElement>(null), listId = useId();
  const result = loaded?.context === context ? loaded.value : {items: [], total: 0};
  const index = result.items.findIndex(item => item.id === selected), selectedItem = result.items[index];
  const detailKey = JSON.stringify([context, selected]), currentDetail = detail?.key === detailKey ? detail : undefined;
  const detailText = [currentDetail?.text, currentDetail?.detail].filter(Boolean).join("\n\n");
  const occurrences = useMemo(() => textMatches(detailText, query), [detailText, query]);
  function reset(nextQuery = query, nextRole = role) { setQuery(nextQuery); setRole(nextRole); setOffsets([0]); setPageIndex(0); chooseEdge.current = "first"; }
  useEffect(() => {
    let alive = true;
    setSelected(""); setDetail(undefined); setLoaded(undefined); setError("");
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void callRef.current("chat.search", {id, query: query.trim(), offset, ...(role ? {role} : {})}).then((value: SearchPage) => {
        if (!alive) return;
        const page = searchPageValue(value, offset);
        setLoaded({context, value: page});
        setSelected((chooseEdge.current === "last" ? page.items.at(-1) : page.items[0])?.id || "");
      }).catch(e => {if (alive) setError(errorText(e));}).finally(() => {if (alive) setLoading(false);});
    }, 200);
    return () => {alive = false; clearTimeout(timer);};
  }, [context, retry]);
  useEffect(() => {
    let alive = true;
    setDetailError(""); setDetail(undefined); setHit(0);
    if (!selectedItem) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void callRef.current("chat.searchItem", {id, itemId: selected}).then(value => {
      if (alive) setDetail({key: detailKey, ...value});
    }).catch(e => {if (alive) setDetailError(errorText(e));}).finally(() => {if (alive) setDetailLoading(false);});
    return () => {alive = false;};
  }, [detailKey, detailRetry, !!selectedItem]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"}); }, [selected]);
  useEffect(() => { detailView.current?.querySelector('[data-active="true"]')?.scrollIntoView({block: "nearest"}); }, [hit, currentDetail]);
  function changePage(direction: -1 | 1, edge: "first" | "last" = "first") {
    if (loading) return;
    chooseEdge.current = edge;
    if (direction < 0 && pageIndex > 0) setPageIndex(pageIndex - 1);
    if (direction > 0 && result.next !== undefined) {
      setOffsets(previous => [...previous.slice(0, pageIndex + 1), result.next!]); setPageIndex(pageIndex + 1);
    }
  }
  function move(direction: -1 | 1) {
    if (loading || !result.items.length) return;
    const next = index + direction;
    if (next >= 0 && next < result.items.length) setSelected(result.items[next].id);
    else changePage(direction, direction > 0 ? "first" : "last");
  }
  const canPrevious = !loading && (index > 0 || pageIndex > 0), canNext = !loading && (index + 1 < result.items.length || result.next !== undefined);
  return <Dialog title={t("搜索会话内容")} onClose={close}><div className="chat-search chat-search-workspace">
    <header><Search size={20}/><div><h2>{t("搜索会话内容")}</h2><p>{t("在消息、代码和工具输出中找到依据")}</p></div></header>
    <div className="conversation-search-controls"><input autoFocus data-search-query role="combobox" aria-controls={listId} aria-expanded={!!result.items.length} aria-activedescendant={selectedItem ? `${listId}-${index}` : undefined} aria-label={t("搜索会话内容")} value={query} maxLength={200} onChange={e => reset(e.target.value)} placeholder={t("搜索消息、代码或工具输出")} onKeyDown={e => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {e.preventDefault();move(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);}
    }}/><select data-search-role aria-label={t("消息角色")} value={role} onChange={e => reset(query, e.target.value)}><option value="">{t("全部角色")}</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{t(label)}</option>)}</select></div>
    {error && <div className="conversation-search-error" role="alert">{error}<button onClick={() => setRetry(v => v + 1)}>{t("重新搜索")}</button></div>}
    <div className="conversation-search-summary"><span role="status">{loading ? t("正在搜索…") : !query.trim() ? t("输入关键词开始搜索") : t("找到 {count} 条消息", {count: result.total})}</span><div><button data-search-prev-match disabled={!canPrevious} onClick={() => move(-1)} title={t("上一条匹配")} aria-label={t("上一条匹配")}><ArrowUp size={15}/></button><span>{selectedItem ? `${offset + index + 1} / ${result.total}` : "—"}</span><button data-search-next-match disabled={!canNext} onClick={() => move(1)} title={t("下一条匹配")} aria-label={t("下一条匹配")}><ArrowDown size={15}/></button></div></div>
    <div className="conversation-search-body"><div className="search-results" ref={list} role="listbox" id={listId} aria-label={t("搜索结果")} aria-busy={loading}>{!loading && result.items.map((item,i) => <button key={item.id} id={`${listId}-${i}`} data-search-result={item.id} role="option" tabIndex={selected === item.id ? 0 : -1} aria-selected={selected === item.id} onClick={() => setSelected(item.id)}><small>{t(labels[item.role])} · {formatDate(item.at)}</small><span><Highlight text={item.excerpt} query={query}/></span></button>)}{!loading && query.trim() && !error && !result.items.length && <p>{t("没有匹配内容，试试其他关键词或角色")}</p>}</div>
    <section className="search-detail" data-search-detail ref={detailView} aria-label={t("消息上下文")} aria-busy={detailLoading}>
      {detailLoading && <p role="status">{t("正在加载消息…")}</p>}{detailError && <div role="alert">{detailError}<button onClick={() => setDetailRetry(v => v + 1)}>{t("重新加载消息")}</button></div>}
      {!detailLoading && currentDetail && <><div className="search-detail-toolbar"><strong>{selectedItem ? t(labels[selectedItem.role]) : t("消息上下文")}</strong><CopyButton text={detailText} label={t("复制消息上下文")}/><div><button data-search-occurrence="prev" disabled={!occurrences.matches.length} aria-label={t("上一处关键词")} onClick={() => setHit((hit - 1 + occurrences.matches.length) % occurrences.matches.length)}><ChevronLeft size={14}/></button><span>{occurrences.matches.length ? `${hit + 1} / ${occurrences.matches.length}${occurrences.limited ? "+" : ""}` : t("未找到原文匹配")}</span><button data-search-occurrence="next" disabled={!occurrences.matches.length} aria-label={t("下一处关键词")} onClick={() => setHit((hit + 1) % occurrences.matches.length)}><ChevronRight size={14}/></button></div></div><pre><Highlight text={detailText} query={query} active={hit}/></pre>{currentDetail.truncated && <p>{t("内容较长，仅显示前段，请导出会话查看完整内容。")}</p>}{occurrences.limited && <p>{t("匹配较多，仅高亮前 1000 处；原文保持完整。")}</p>}</>}
      {!detailLoading && !currentDetail && !detailError && <p>{t("选择一条结果，查看消息与工具输出")}</p>}
    </section></div>
    <footer><div><button data-search-prev-page disabled={loading || !pageIndex} onClick={() => changePage(-1)}>{t("上一页")}</button><button data-search-next-page disabled={loading || result.next === undefined} onClick={() => changePage(1)}>{t("下一页")}</button></div><small>{t("↑↓ 或 Enter 切换结果 · Shift+Enter 返回")}</small>{!!result.items.length && <CopyButton text={result.items.map(item => `${t(labels[item.role])} · ${formatDate(item.at)}\n${item.excerpt}`).join("\n\n")} label={t("复制本页摘要")}/>}</footer>
  </div></Dialog>;
}
