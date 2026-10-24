import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Minus,
  Plus,
  WrapText,
} from "lucide-react";
import { gitHunks } from "../shared/git-hunks";
import { reviewDiff } from "../shared/review-diff";
import { t, useI18n } from "./i18n";
import "./review.css";
import { ReviewHunkBody } from "./ReviewHunkBody";

export function DiffReview({
  diff,
  path,
  staged,
  ready,
  busy,
  conflict,
  comment,
  stageHunk,
}: {
  diff: string;
  path: string;
  staged: boolean;
  ready: boolean;
  busy: boolean;
  conflict: boolean;
  comment: (text: string) => void;
  stageHunk: (index: number) => void;
}) {
  useI18n();
  const parsed = useMemo(() => reviewDiff(diff), [diff]);
  const eligible = useMemo(
    () => !conflict && gitHunks(diff).length > 0,
    [diff, conflict],
  );
  const [wrap, setWrap] = useState(true);
  const initialCollapsed = useMemo(
    () =>
      parsed.hunks.reduce((n, h) => n + h.lines.length, 0) > 4000
        ? new Set(parsed.hunks.slice(1).map((h) => h.index))
        : new Set<number>(),
    [parsed],
  );
  const [collapseState, setCollapseState] = useState({
    diff,
    items: initialCollapsed,
  });
  const collapsed =
    collapseState.diff === diff ? collapseState.items : initialCollapsed;
  const setCollapsed = (
    change: Set<number> | ((old: Set<number>) => Set<number>),
  ) => {
    setCollapseState((old) => ({
      diff,
      items:
        typeof change === "function"
          ? change(old.diff === diff ? old.items : initialCollapsed)
          : change,
    }));
  };
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    setCollapseState((old) =>
      old.diff === diff ? old : { diff, items: initialCollapsed },
    );
    setActive(0);
  }, [diff, initialCollapsed]);
  const allCollapsed =
    parsed.hunks.length > 0 && collapsed.size === parsed.hunks.length;
  const jump = (index: number) => {
    setActive(index);
    setCollapsed((old) => {
      const next = new Set(old);
      next.delete(index);
      return next;
    });
    const target = container.current?.querySelector<HTMLButtonElement>(
      `[data-hunk="${index}"] .review-disclosure`,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <section className="diff-review" aria-label={t("差异审阅")}>
      <div className="review-controls">
        <div
          className="review-stats"
          aria-label={t("新增 {p0} 行，删除 {p1} 行", {
            p0: parsed.added,
            p1: parsed.removed,
          })}
        >
          <span className="review-added">+{parsed.added}</span>
          <span className="review-removed">−{parsed.removed}</span>
        </div>
        <span className="review-position" aria-live="polite">
          {t("{p0} / {p1} 块", {
            p0: parsed.hunks.length ? active + 1 : 0,
            p1: parsed.hunks.length,
          })}
        </span>
        <button
          title={t("上一块变更")}
          aria-label={t("上一块变更")}
          disabled={!active}
          onClick={() => jump(active - 1)}
        >
          <ArrowUp size={14} />
        </button>
        <button
          title={t("下一块变更")}
          aria-label={t("下一块变更")}
          disabled={active >= parsed.hunks.length - 1}
          onClick={() => jump(active + 1)}
        >
          <ArrowDown size={14} />
        </button>
        <button
          title={t("折叠所有变更块")}
          aria-label={t("折叠所有变更块")}
          aria-pressed={allCollapsed}
          disabled={!parsed.hunks.length}
          onClick={() =>
            setCollapsed(
              allCollapsed
                ? new Set()
                : new Set(parsed.hunks.map((h) => h.index)),
            )
          }
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          title={t("长行自动换行")}
          aria-label={t("长行自动换行")}
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={14} />
        </button>
      </div>
      {!ready && (
        <p className="diff-note" role="status">
          {t("正在更新差异…")}
        </p>
      )}
      {ready && !diff && <p className="diff-note">{t("此视图没有文本差异")}</p>}
      {ready && !!diff && !eligible && (
        <p className="diff-note">{t("此差异仅支持整文件操作")}</p>
      )}
      <div className="diff-lines review-lines" data-wrap={wrap} ref={container}>
        {!!initialCollapsed.size && (
          <p className="diff-note">
            {t("大差异先展开首块，可展开其他块继续审阅。")}
          </p>
        )}
        {!!parsed.metadata.length && (
          <details className="review-metadata" open={!parsed.hunks.length}>
            <summary>{t("差异元数据")}</summary>
            <pre>{parsed.metadata.join("\n")}</pre>
          </details>
        )}
        {parsed.hunks.map((hunk) => (
          <section
            className="review-hunk"
            key={hunk.index}
            data-hunk={hunk.index}
          >
            <header className="review-hunk-heading">
              <button
                className="review-disclosure"
                aria-expanded={!collapsed.has(hunk.index)}
                aria-controls={`${id}-${hunk.index}`}
                onClick={() => {
                  setActive(hunk.index);
                  setCollapsed((old) => {
                    const next = new Set(old);
                    next.has(hunk.index)
                      ? next.delete(hunk.index)
                      : next.add(hunk.index);
                    return next;
                  });
                }}
              >
                {collapsed.has(hunk.index) ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                <code>{hunk.header}</code>
              </button>
              {eligible && (
                <button
                  className="hunk-control"
                  disabled={busy || !ready}
                  aria-label={t(
                    staged ? "取消暂存第 {p0} 块" : "暂存第 {p0} 块",
                    { p0: hunk.index + 1 },
                  )}
                  onClick={() => stageHunk(hunk.index)}
                >
                  {staged ? <Minus size={12} /> : <Plus size={12} />}
                  {staged ? t("取消暂存此块") : t("暂存此块")}
                </button>
              )}
            </header>
            <div id={`${id}-${hunk.index}`} hidden={collapsed.has(hunk.index)}>
              {!collapsed.has(hunk.index) && (
                <ReviewHunkBody
                  hunk={hunk}
                  path={path}
                  ready={ready}
                  comment={comment}
                />
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
