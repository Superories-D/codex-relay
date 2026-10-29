import React, { useEffect, useState } from "react";
import type { Job } from "../shared/types";
import {
  deliveryChecksSchema,
  type DeliveryCheck,
  type DeliveryState,
} from "../shared/delivery";
import { Dialog } from "./Dialog";
import { t, useI18n, errorText } from "./i18n";
import "./delivery.css";

const statusLabels = {
  passed: "验收通过",
  failed: "验收未通过",
  unverified: "暂无法验证",
};
export function DeliverySummary({ job, open }: { job: Job; open: () => void }) {
  useI18n();
  if (!job.delivery?.checks.length) return null;
  const latest = job.delivery.reports.at(-1);
  const label = job.delivery.pendingCompletion
    ? "正在验收交付产物"
    : job.delivery.staleEvidence && job.delivery.staleEvidence.reportId === latest?.id && latest
      ? "交付证据已失效"
    : latest?.revision === job.delivery.revision
      ? statusLabels[latest.status]
      : "等待交付验收";
  return (
    <button className="delivery-summary" onClick={open}>
      {t("交付验收")} · {job.delivery.checks.length} · {t(label)}
    </button>
  );
}
const codeLabels: Record<string, string> = {
  verified: "条件满足",
  missing: "产物不存在",
  tooSmall: "文件小于要求",
  textMissing: "未找到要求的内容",
  hashMismatch: "SHA256 不一致",
  jsonMismatch: "JSON 字段与预期不符",
  invalidText: "文本或 JSON 编码无效",
  jsonTooLarge: "JSON 超过 4 MiB，无法解析验证",
  notFile: "路径不是普通文件",
  outsideWorkspace: "路径超出任务目录",
  changedDuringRead: "检查期间文件发生变化，请重试",
  ioError: "文件暂时无法读取",
  cancelled: "验收已取消",
};
type DraftCheck = DeliveryCheck & { jsonValue?: string };
export function DeliveryDialog({
  job,
  initial = [],
  call,
  saveDraft,
  purpose = "task",
  repair,
  close,
}: {
  job?: Job;
  initial?: DeliveryCheck[];
  call: (name: string, args?: unknown) => Promise<any>;
  saveDraft?: (checks: DeliveryCheck[]) => void;
  purpose?: "task" | "plan" | "existing";
  repair?: (text: string) => void;
  close: () => void;
}) {
  useI18n();
  const [state, setState] = useState<DeliveryState>(
    job?.delivery || { revision: 0, checks: initial, reports: [] },
  );
  const [checks, setChecks] = useState<DraftCheck[]>(
    structuredClone(job?.delivery?.checks || initial),
  );
  const [loading, setLoading] = useState(!!job);
  const [verifying, setVerifying] = useState(false);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [kind, setKind] = useState<DeliveryCheck["kind"]>("file");
  const blocked =
    !!job &&
    (["preparing", "running", "pausing", "rotating", "watching"].includes(
      job.state,
    ) ||
      !!job.recoveryRequired);
  useEffect(() => {
    if (!job) return;
    let alive = true;
    void call("delivery.read", job.id)
      .then((value) => {
        if (alive) {
          setState(value);
          setChecks(structuredClone(value.checks));
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [job?.id]);
  useEffect(() => {
    const incoming = job?.delivery;
    if (!incoming || dirty || busy || loading) return;
    setState((current) => {
      if (
        incoming.revision < current.revision ||
        (incoming.reports.at(-1)?.finishedAt || 0) <
          (current.reports.at(-1)?.finishedAt || 0)
      )
        return current;
      return structuredClone(incoming);
    });
    if (incoming.revision > state.revision)
      setChecks(structuredClone(incoming.checks));
  }, [job?.delivery, dirty, busy, loading]);
  function update(index: number, value: Partial<DraftCheck>) {
    setChecks((old) =>
      old.map((row, i) =>
        i === index ? ({ ...row, ...value } as DraftCheck) : row,
      ),
    );
    setDirty(true);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const report = state.reports.at(-1),
    current = report?.revision === state.revision && !(state.staleEvidence && state.staleEvidence.reportId === report?.id);
  return (
    <Dialog title={t("交付验收")} busy={busy} onClose={close}>
      <div className="delivery-dialog">
        <h2>{t("交付验收")}</h2>
        <p>
          {t(
            "为任务定义可检查的交付条件。完成后自动读取实际文件，未通过时保留结果并阻止依赖任务继续。",
          )}
        </p>
        <p className="delivery-help">
          {t(
            "路径相对于任务目录。文件和 SHA256 检查读取完整文件；JSON 字段检查支持最多 4 MiB 的 UTF-8 文档。",
          )}
        </p>
        {job && <code className="delivery-workspace">{job.cwd}</code>}
        {job?.checkpoint&&<div className="delivery-help"><strong>{t("检查点任务分支")}: {job.checkpoint.branch}</strong><p>{t("来源工作区")}: {job.checkpoint.sourceCwd}</p><code>SHA256 {job.checkpoint.manifestSha256}</code><p>{t("验收条件需要在当前分支重新验证。")}</p></div>}
        {error && <p role="alert">{error}</p>}
        {blocked && (
          <p role="status">{t("请先暂停任务，再修改或运行验收。")}</p>
        )}
        {loading && <p role="status">{t("正在读取验收条件…")}</p>}
        {state.staleEvidence && <p role="status">{t("产物已变化或当前证据无法确认。历史通过记录保留，请重新验收后继续。")}</p>}
        <fieldset disabled={busy || blocked || loading}>
          <legend>{t("验收条件")}</legend>
          {!!state.checks.length && (
            <p className="delivery-help">
              {t(
                "删除全部条件会解除这次验收造成的等待；其他暂停或错误仍保持。",
              )}
            </p>
          )}
          {checks.map((check, index) => (
            <div className="delivery-check" key={index}>
              <label>
                {t("条件名称")}
                <input
                  aria-label={t("条件名称") + ` ${index + 1}`}
                  maxLength={200}
                  value={check.label}
                  onChange={(e) => update(index, { label: e.target.value })}
                />
              </label>
              <label>
                {t("产物相对路径")}
                <input
                  aria-label={t("产物相对路径") + ` ${index + 1}`}
                  maxLength={2000}
                  placeholder="dist/report.json"
                  value={check.path}
                  onChange={(e) => update(index, { path: e.target.value })}
                />
              </label>
              {check.kind === "file" && (
                <label>
                  {t("最小字节数")}
                  <input
                    aria-label={t("最小字节数") + ` ${index + 1}`}
                    type="number"
                    min={0}
                    step={1}
                    value={check.minBytes}
                    onChange={(e) =>
                      update(index, { minBytes: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              {check.kind === "contains" && (
                <label>
                  {t("必须包含的文本")}
                  <textarea
                    aria-label={t("必须包含的文本") + ` ${index + 1}`}
                    maxLength={4000}
                    value={check.text}
                    onChange={(e) => update(index, { text: e.target.value })}
                  />
                </label>
              )}
              {check.kind === "sha256" && (
                <label>
                  SHA256
                  <input
                    aria-label={`SHA256 ${index + 1}`}
                    maxLength={64}
                    value={check.sha256}
                    onChange={(e) => update(index, { sha256: e.target.value })}
                  />
                </label>
              )}
              {check.kind === "json" && (
                <>
                  <label>
                    JSON Pointer
                    <input
                      aria-label={`JSON Pointer ${index + 1}`}
                      placeholder="/status"
                      value={check.pointer}
                      onChange={(e) =>
                        update(index, { pointer: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("预期 JSON 值")}
                    <input
                      aria-label={t("预期 JSON 值") + ` ${index + 1}`}
                      value={check.jsonValue ?? JSON.stringify(check.equals)}
                      onChange={(e) =>
                        update(index, { jsonValue: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              <button
                type="button"
                className="delivery-remove"
                aria-label={t("删除验收条件") + ` ${index + 1}`}
                onClick={() => {
                  setChecks((old) => old.filter((_, i) => i !== index));
                  setDirty(true);
                }}
              >
                {t("删除验收条件")}
              </button>
            </div>
          ))}
          {!checks.length && <p>{t("尚未设置验收条件")}</p>}
          <div className="delivery-actions">
            <select
              aria-label={t("验收类型")}
              value={kind}
              onChange={(e) => setKind(e.target.value as DeliveryCheck["kind"])}
            >
              <option value="file">{t("文件存在与大小")}</option>
              <option value="contains">{t("文本内容")}</option>
              <option value="sha256">SHA256</option>
              <option value="json">{t("JSON 字段")}</option>
            </select>
            <button
              type="button"
              disabled={checks.length >= 30}
              onClick={() => {
                const base = { path: "", label: t("交付产物") };
                setChecks((old) => [
                  ...old,
                  kind === "file"
                    ? { ...base, kind, minBytes: 1 }
                    : kind === "contains"
                      ? { ...base, kind, text: "" }
                      : kind === "sha256"
                        ? { ...base, kind, sha256: "" }
                        : { ...base, kind, pointer: "", equals: true },
                ]);
                setDirty(true);
              }}
            >
              {t("添加验收条件")}
            </button>
            <button
              type="button"
              onClick={() =>
                void action(async () => {
                  const input = checks.map(({ jsonValue, ...check }) => {
                    if (check.kind !== "json" || jsonValue === undefined)
                      return check;
                    try {
                      const equals = JSON.parse(jsonValue);
                      if (
                        equals !== null &&
                        !["string", "number", "boolean"].includes(typeof equals)
                      )
                        throw Error();
                      return { ...check, equals };
                    } catch {
                      throw Error(t("预期值必须是文本、数字、布尔值或 null"));
                    }
                  });
                  const parsed = deliveryChecksSchema.safeParse(input);
                  if (!parsed.success)
                    throw Error(t("请检查条件名称、相对路径和预期值"));
                  if (!job) {
                    saveDraft?.(parsed.data);
                    close();
                    return;
                  }
                  const result = await call("delivery.save", {
                    id: job.id,
                    revision: state.revision,
                    checks: parsed.data,
                  });
                  setState(result);
                  setChecks(structuredClone(result.checks));
                  setDirty(false);
                })
              }
            >
              {t("保存验收条件")}
            </button>
          </div>
        </fieldset>
        {job && (
          <div className="delivery-actions">
            <button
              disabled={
                busy || blocked || dirty || loading || !state.checks.length
              }
              onClick={() =>
                void action(async () => {
                  setVerifying(true);
                  try {
                    setState(await call("delivery.run", job.id));
                  } finally {
                    setVerifying(false);
                  }
                })
              }
            >
              {t("重新验收")}
            </button>
            {(verifying || job.delivery?.pendingCompletion) && (
              <button
                onClick={() => {
                  void call("delivery.cancel", job.id).catch((e) =>
                    setError(errorText(e)),
                  );
                }}
              >
                {t("取消验收")}
              </button>
            )}
            {repair && <button
              disabled={
                busy ||
                dirty ||
                !current ||
                report?.status === "passed" ||
                !report
              }
              onClick={() =>
                void action(async () => {
                  repair(await call("delivery.repair", job.id));
                  close();
                })
              }
            >
              {t("将修正要求加入草稿")}
            </button>}
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const document = await call("delivery.export", job.id),
                    url = URL.createObjectURL(
                      new Blob([JSON.stringify(document, null, 2)], {
                        type: "application/json",
                      }),
                    );
                  const anchor = window.document.createElement("a");
                  anchor.href = url;
                  anchor.download = `delivery-${job.id}.json`;
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                })
              }
            >
              {t("导出验收证据")}
            </button>
          </div>
        )}
        {dirty && job && (
          <p role="status">{t("条件尚未保存，保存后再运行验收。")}</p>
        )}
        <DeliveryEvidence state={state}/>
        {!job && <p>{t(purpose === "plan" ? "保存后写入当前验收方案；不会创建或发送任务。" : purpose === "existing" ? "保存后更新当前任务的验收条件；历史报告保留，需重新验收。" : "保存后随新任务提交，任务结束时自动验收。")}</p>}
      </div>
    </Dialog>
  );
}

export function DeliveryEvidence({state}: {state: DeliveryState}) {
  const report = state.reports.at(-1);
  if (!report) return null;
  const current = report.revision === state.revision && state.staleEvidence?.reportId !== report.id;
  return (
    <section className="delivery-results" aria-label={t("验收结果")}>
      <h3 data-status={current ? report.status : "unverified"}>
        {t(current ? statusLabels[report.status] : "历史验收结果")} ·{" "}
        {new Date(report.finishedAt).toLocaleString()}
      </h3>
      <p>{t("这是检查时刻的文件证据；后续文件变化需要重新验收。")}</p>
      {report.findings.map((finding, index) => (
        <article key={index} data-status={finding.status}>
          <strong>
            {finding.check.label} · {t(statusLabels[finding.status])}
          </strong>
          <code>{finding.check.path}</code>
          <p>{t(codeLabels[finding.code] || finding.code)}</p>
          {finding.bytes !== undefined && (
            <span>{finding.bytes.toLocaleString()} bytes</span>
          )}
          {finding.sha256 && <code>SHA256 {finding.sha256}</code>}
        </article>
      ))}
      {state.reports.length > 1 && (
        <details>
          <summary>
            {t("历史验收记录")} ({state.reports.length - 1})
          </summary>
          {state.reports
            .slice(0, -1)
            .reverse()
            .map((old) => (
              <p key={old.id}>
                {new Date(old.finishedAt).toLocaleString()} · r
                {old.revision} · {t(statusLabels[old.status])}
              </p>
            ))}
        </details>
      )}
    </section>
  );
}
