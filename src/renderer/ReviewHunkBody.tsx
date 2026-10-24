import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import {
  reviewCodeBlock,
  reviewExcerpt,
  reviewLocation,
  type ReviewHunk,
} from "../shared/review-diff";
import { t } from "./i18n";

const PAGE_SIZE = 400;
export function ReviewHunkBody({
  hunk,
  path,
  ready,
  comment,
}: {
  hunk: ReviewHunk;
  path: string;
  ready: boolean;
  comment: (text: string) => void;
}) {
  const [position, setPosition] = useState({ lines: hunk.lines, page: 0 });
  const page = position.lines === hunk.lines ? position.page : 0;
  useEffect(
    () =>
      setPosition((old) =>
        old.lines === hunk.lines ? old : { lines: hunk.lines, page: 0 },
      ),
    [hunk.lines],
  );
  const pages = Math.ceil(hunk.lines.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const navigation = useRef<HTMLDivElement>(null);
  const go = (next: number) => {
    setPosition({ lines: hunk.lines, page: next });
    navigation.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <>
      {pages > 1 && (
        <div className="review-pagination" ref={navigation}>
          <span aria-live="polite">
            {t("显示 {p0}–{p1} / {p2} 行", {
              p0: start + 1,
              p1: Math.min(start + PAGE_SIZE, hunk.lines.length),
              p2: hunk.lines.length,
            })}
          </span>
          <button
            aria-label={t("上一页差异")}
            disabled={page === 0}
            onClick={() => go(page - 1)}
          >
            <ArrowLeft size={13} />
          </button>
          <select
            aria-label={t("变更块页码")}
            value={page}
            onChange={(event) => go(Number(event.target.value))}
          >
            {Array.from({ length: pages }, (_, index) => (
              <option key={index} value={index}>
                {index + 1} / {pages}
              </option>
            ))}
          </select>
          <button
            aria-label={t("下一页差异")}
            disabled={page === pages - 1}
            onClick={() => go(page + 1)}
          >
            <ArrowRight size={13} />
          </button>
          <small>{t("分页显示；暂存操作仍作用于完整变更块。")}</small>
        </div>
      )}
      {hunk.lines.slice(start, start + PAGE_SIZE).map((line) => (
        <div
          className={`review-line ${line.kind}`}
          key={line.index}
          data-old-line={line.oldLine}
          data-new-line={line.newLine}
        >
          <span className="review-number" aria-hidden="true">
            {line.oldLine}
          </span>
          <span className="review-number" aria-hidden="true">
            {line.newLine}
          </span>
          {line.kind !== "note" ? (
            <button
              className="review-comment"
              disabled={!ready}
              title={t("把这一行加入审查意见")}
              aria-label={t("评论 {p0}（{p1}）", {
                p0: reviewLocation(path, line),
                p1: line.kind === "removed" ? t("旧版本") : t("新版本"),
              })}
              onClick={() =>
                comment(
                  t("请检查 {p0}（{p1}）附近的变更：\n\n{p2}\n\n意见：", {
                    p0: reviewLocation(path, line),
                    p1: line.kind === "removed" ? t("旧版本") : t("新版本"),
                    p2: reviewCodeBlock(reviewExcerpt(line, hunk)),
                  }),
                )
              }
            >
              <Plus size={12} />
            </button>
          ) : (
            <span />
          )}
          <code>{line.text || " "}</code>
        </div>
      ))}
    </>
  );
}
