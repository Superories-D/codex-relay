import React from "react";
import type { JobTokenUsage } from "../shared/types";
import { tokenCount, tokenCounts } from "../shared/token-usage";
import { useI18n } from "./i18n";

export function TokenUsageCard({ usage }: { usage: JobTokenUsage }) {
  const { language, t } = useI18n();
  const total = tokenCounts(usage), last = tokenCounts(usage.last);
  if (!total) return null;
  const window = tokenCount(usage.modelContextWindow) && usage.modelContextWindow > 0
    ? usage.modelContextWindow : undefined;
  const format = (value: number) => value.toLocaleString(language);
  const percent = last && window ? Math.min(100, last.totalTokens / window * 100) : undefined;
  return (
    <section className="usage-card" aria-label={t("上下文使用")}>
      <div className="usage-heading">
        <span>{t("上下文使用")}</span>
        {percent !== undefined && <span>{percent.toLocaleString(language, { maximumFractionDigits: 1 })}%</span>}
      </div>
      {last ? <>
        <strong className="usage-current">
          {format(last.totalTokens)}{window ? ` / ${format(window)}` : ""} tokens
        </strong>
        {percent !== undefined && (
          <div className="usage-track" role="meter" aria-label={t("上下文使用")}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            aria-valuetext={t("{used} / {limit} tokens", { used: format(last.totalTokens), limit: format(window!) })}>
            <i style={{ width: `${percent}%` }} />
          </div>
        )}
        <small>{t("按最近一次用量更新")}</small>
      </> : <small>{t("当前上下文用量暂不可用")}</small>}
      <details className="usage-total">
        <summary>{t("线程累计用量")} · {format(total.totalTokens)} tokens</summary>
        <small>{t("输入")} {format(total.inputTokens)} {t("· 输出")} {format(total.outputTokens)}</small>
      </details>
    </section>
  );
}
