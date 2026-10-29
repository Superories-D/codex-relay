import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, CircleAlert, FilePenLine, LoaderCircle, Search, SquareTerminal, Wrench, X } from "lucide-react";
import type { ChatItem } from "../shared/types";
import { RichMessage } from "./RichMessage";
import { CopyButton } from "./CopyButton";
import { t, useI18n } from "./i18n";
import { activityRuns } from "./chat-view";
import { usePresence } from "./MotionRegion";
import { MediaContext } from "./ChatImages";
import {activityCopyText, activityStatus, filterActivityTimeline, isToolActivity, nextFailedActivity, type ActivityKindFilter, type ActivityStatusFilter} from "./activity-workspace";
import "./search-activity.css";

type Props = Omit<React.ComponentProps<typeof RichMessage>, "item">;
type Reveal = {id: string; sequence: number};
type Expansion = {open: boolean; sequence: number};
function ActivityEntry({item, reveal, expansion, ...props}: Props & {item: ChatItem; reveal: Reveal; expansion: Expansion}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!expansion.sequence || !element.current) return;
    for (const details of Array.from(element.current.querySelectorAll("details"))) details.open = expansion.open;
  }, [expansion.sequence]);
  useLayoutEffect(() => {
    if (reveal.id !== item.id || !element.current) return;
    for (const details of Array.from(element.current.querySelectorAll("details"))) details.open = true;
    element.current.scrollIntoView({block: "nearest"});
    element.current.focus({preventScroll: true});
  }, [reveal.id, reveal.sequence]);
  return <div ref={element} className={`activity-work-entry status-${activityStatus(item)}`} data-activity-id={item.id} tabIndex={-1}>
    <RichMessage item={activityStatus(item) === "running" && item.status !== "running" ? {...item, status: "running"} : item} {...props}/>
    <div className="activity-work-entry-actions"><CopyButton text={activityCopyText([item], t("当前显示预览；完整内容请查看原始记录"))} label={t("复制这项操作")} iconOnly/>{activityStatus(item) === "failed" && <span><CircleAlert size={11}/>{t("操作未完成，请检查输出")}</span>}</div>
  </div>;
}
function ActivityGroup({items, reveal, expansion, filtered, ...props}: Props & {items: ChatItem[]; reveal: Reveal; expansion: Expansion; filtered: boolean}) {
  useI18n();
  const [expanded, setExpanded] = useState(false), present = usePresence(expanded);
  useEffect(() => {if (expansion.sequence) setExpanded(expansion.open);}, [expansion.sequence]);
  useEffect(() => {if (filtered) setExpanded(true);}, [filtered]);
  useEffect(() => {if (items.some(item => item.id === reveal.id)) setExpanded(true);}, [reveal.id, reveal.sequence]);
  const executing = items.some(item => activityStatus(item) === "running"), failed = items.filter(item => activityStatus(item) === "failed").length;
  const edited = items.some(item => ["fileChange", "diff"].includes(item.kind)), commands = items.some(item => item.kind === "commandExecution");
  return <details className={`activity-group ${executing ? "is-running" : ""} ${failed ? "has-failures" : ""}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{executing ? <LoaderCircle size={16} className="spin"/> : edited ? <FilePenLine size={16}/> : commands ? <SquareTerminal size={16}/> : <Wrench size={16}/>}<span>{edited && commands ? t("编辑了文件并运行了命令") : edited ? t("编辑了文件") : commands ? t("运行了命令") : t("工具活动")}</span><small>{t("{p0} 项操作", {p0: items.length})}</small>{executing && <small className="activity-running">{t("进行中")}</small>}{!!failed && <small className="activity-failed" role="status">{t("{p0} 项失败", {p0: failed})}</small>}<ChevronDown size={14} className="disclosure-chevron"/></summary>
    <div className="activity-group-scroll">{present && items.map(item => <ActivityEntry key={item.id} item={item} reveal={reveal} expansion={expansion} {...props}/>)}</div>
  </details>;
}
export function ActivityTimeline({items, scope, jobId, ...props}: Props & {items: ChatItem[]; scope: string; jobId?: string}) {
  useI18n();
  const [filter, setFilter] = useState<ActivityStatusFilter>("all"), [kind, setKind] = useState<ActivityKindFilter>("all"), [query, setQuery] = useState("");
  const [reveal, setReveal] = useState<Reveal>({id: "", sequence: 0}), [expansion, setExpansion] = useState<Expansion>({open: false, sequence: 0});
  useEffect(() => {setFilter("all");setKind("all");setQuery("");setReveal({id:"",sequence:0});setExpansion({open:false,sequence:0});}, [scope,jobId]);
  const mediaContext = useMemo(() => ({id: jobId || scope, ...(jobId ? {threadId: scope} : {})}), [jobId, scope]);
  const visibleItems = useMemo(() => items.filter(item => item.kind !== "questionRequest"), [items]);
  const tools = useMemo(() => visibleItems.filter(isToolActivity), [visibleItems]);
  const filteredItems = useMemo(() => filterActivityTimeline(visibleItems, filter, kind, query), [visibleItems, filter, kind, query]);
  const matchingTools = filteredItems.filter(isToolActivity), failed = tools.filter(item => activityStatus(item) === "failed"), running = tools.filter(item => activityStatus(item) === "running");
  const filtering = filter !== "all" || kind !== "all" || !!query.trim();
  const controls = tools.length >= 3 || failed.length > 0;
  function nextFailure() {
    const next = nextFailedActivity(tools, reveal.id);
    if (!next) return;
    setFilter("all");setKind("all");setQuery("");setReveal(previous => ({id:next.id,sequence:previous.sequence + 1}));
  }
  return <MediaContext.Provider value={mediaContext}><div className="activity-timeline-workspace">
    {controls && <section className="activity-workspace-toolbar" aria-label={t("执行记录筛选")}>
      <div className="activity-workspace-status"><span>{t("已加载 {count} 项操作", {count:tools.length})}</span><div role="group" aria-label={t("操作状态")}>{([["all","全部操作",tools.length],["running","进行中",running.length],["failed","未完成",failed.length]] as const).map(([value,label,count]) => <button key={value} data-activity-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}<small>{count}</small></button>)}</div></div>
      <div className="activity-workspace-filters"><label><Search size={14}/><input data-activity-query aria-label={t("搜索命令、文件或输出")} placeholder={t("搜索命令、文件或输出")} value={query} onChange={event => setQuery(event.target.value)} maxLength={200}/>{query && <button onClick={() => setQuery("")} aria-label={t("清除搜索")}><X size={12}/></button>}</label><select data-activity-kind aria-label={t("操作类型")} value={kind} onChange={event => setKind(event.target.value as ActivityKindFilter)}><option value="all">{t("全部类型")}</option><option value="commands">{t("命令执行")}</option><option value="files">{t("文件变更")}</option><option value="other">{t("其他工具")}</option></select></div>
      <div className="activity-workspace-actions"><button data-activity-next-failure disabled={!failed.length} onClick={nextFailure}><CircleAlert size={13}/>{t("定位下一项未完成")}</button><button data-activity-expand="all" onClick={() => setExpansion(previous => ({open:true,sequence:previous.sequence + 1}))}><ChevronsUpDown size={13}/>{t("展开全部操作")}</button><button data-activity-expand="none" onClick={() => setExpansion(previous => ({open:false,sequence:previous.sequence + 1}))}><ChevronsDownUp size={13}/>{t("收起全部操作")}</button>{!!failed.length && <CopyButton text={activityCopyText(failed, t("当前显示预览；完整内容请查看原始记录"))} label={t("复制未完成操作")}/>}</div>
      {filtering && <p role="status">{t("显示 {shown} / {total} 项操作，聊天正文保持可见",{shown:matchingTools.length,total:tools.length})}</p>}
    </section>}
    {filtering && !matchingTools.length && <p className="activity-workspace-empty" role="status">{t("没有符合条件的操作")}<button onClick={() => {setFilter("all");setKind("all");setQuery("");}}>{t("清除操作筛选")}</button></p>}
    {activityRuns(filteredItems).map(run => run.group ? <ActivityGroup key={`${scope}:${run.items[0].id}`} items={run.items} reveal={reveal} expansion={expansion} filtered={filtering} {...props}/> : isToolActivity(run.items[0]) ? <ActivityEntry key={`${scope}:${run.items[0].id}`} item={run.items[0]} reveal={reveal} expansion={expansion} {...props}/> : <RichMessage key={`${scope}:${run.items[0].id}`} item={run.items[0]} {...props}/>)}
  </div></MediaContext.Provider>;
}
