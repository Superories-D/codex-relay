import { t, useI18n } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import { usePresence } from "./MotionRegion";
import { ChevronDown } from "lucide-react";
import { useComposerPopover } from "./useComposerPopover";

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
const labels: Record<string, string> = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "极高",
  ultra: "最高",
};
const label = (value: string) => t(labels[value] ?? value);

export function ModelPicker({
  model,
  effort,
  accountId,
  open,
  setOpen,
  onChange,
}: {
  model: string;
  effort: string;
  accountId?: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  onChange: (model: string, effort: string) => void;
}) {
  useI18n();
  const present = usePresence(open);

  const root = useRef<HTMLDivElement>(null);
  const popoverStyle = useComposerPopover(root, open, 300);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [list, setList] = useState(false);
  const current =
    models.find((m) => m.model === model || m.id === model) ??
    (!model ? models.find((m) => m.isDefault) : undefined);
  const options = current?.supportedReasoningEfforts ?? [];
  const value = effort || current?.defaultReasoningEffort || "";
  const index = options.findIndex((o) => o.reasoningEffort === value);
  const fraction = Math.max(0, index) / Math.max(1, options.length - 1);
  const name = current?.displayName || model || t("默认模型");
  const strength = value ? label(value) : t("默认强度");

  useEffect(() => {
    let alive = true;
    setModels([]);
    setError("");
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.relay
      .command("account.models", accountId)
      .then((result) => {
        if (alive) setModels(result as ModelOption[]);
      })
      .catch((e) => {
        if (alive) setError(String(e).replace(/^Error: /, ""));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId, retry]);

  useEffect(() => {
    if (!open) {
      setList(false);
      return;
    }
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        root.current
          ?.querySelector<HTMLButtonElement>(".agent-model-trigger")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);

  return (
    <div className="agent-model-picker" ref={root}>
      <button
        className="agent-model-trigger"
        aria-label={t("选择模型和思考强度")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="agent-model-current">{name}</span>
        <span className="agent-model-strength">{strength}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {present && (
        <div
          className="agent-model-popover"
          style={popoverStyle}
          data-open={open}
          inert={!open}
          aria-hidden={!open}
          role="dialog"
          aria-label={t("模型和思考强度")}
        >
          <div className="agent-model-heading">
            <span className="composer-menu-label">{t("思考强度")}</span>
            <strong>{strength}</strong>
            <button
              aria-label={t("重置思考强度")}
              title={t("恢复此模型的默认思考强度")}
              disabled={!current}
              onClick={() => onChange(model, current!.defaultReasoningEffort)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M4 8a8 8 0 1 1-1 6M4 3v5h5" />
              </svg>
            </button>
          </div>
          <button
            className="agent-model-name"
            aria-expanded={list}
            onClick={() => setList(!list)}
          >
            {name}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {loading ? (
            <p className="agent-model-note" role="status">
              {t("正在读取 CLI 模型…")}
            </p>
          ) : error ? (
            <div className="agent-model-note" role="alert">
              {error}
              <button onClick={() => setRetry((n) => n + 1)}>
                {t("重新读取")}
              </button>
            </div>
          ) : !accountId ? (
            <p className="agent-model-note">
              {t("请先在账户中添加并启用登录。")}
            </p>
          ) : (
            <>
              {list ? (
                <div
                  className="agent-model-list"
                  role="group"
                  aria-label={t("可用模型")}
                >
                  {models
                    .filter((m) => !m.hidden || m === current)
                    .map((m) => (
                      <button
                        key={m.id}
                        className={m === current ? "selected" : ""}
                        aria-pressed={m === current}
                        onClick={() => {
                          // Each model has its own supported levels. Never carry an unsupported level across models.
                          onChange(
                            m.model,
                            m.supportedReasoningEfforts.some(
                              (o) => o.reasoningEffort === value,
                            )
                              ? value
                              : m.defaultReasoningEffort,
                          );
                          setList(false);
                        }}
                      >
                        <span>
                          {m.displayName || m.model}
                          {m.isDefault ? t(" · 默认") : ""}
                        </span>
                        <small>{m.description}</small>
                      </button>
                    ))}
                  {!models.length && (
                    <p className="agent-model-note">
                      {t("CLI 未返回可用模型。")}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {options.length > 0 ? (
                    <div className="agent-effort-control">
                      <div
                        className="agent-effort-track"
                        style={
                          {
                            "--effort-fill": `calc(${8 - 16 * fraction}px + ${fraction * 100}%)`,
                          } as React.CSSProperties
                        }
                      >
                        <div className="agent-effort-fill" />
                        <div className="agent-effort-ticks" aria-hidden="true">
                          {options.map((o) => (
                            <i key={o.reasoningEffort} />
                          ))}
                        </div>
                        <input
                          type="range"
                          aria-label={t("思考强度")}
                          aria-valuetext={strength}
                          min={0}
                          max={Math.max(1, options.length - 1)}
                          step={1}
                          value={Math.max(0, index)}
                          disabled={options.length === 1}
                          onChange={(e) =>
                            onChange(
                              model || current!.model,
                              options[Number(e.target.value)].reasoningEffort,
                            )
                          }
                        />
                      </div>
                      <div className="agent-effort-labels">
                        <span>{label(options[0].reasoningEffort)}</span>
                        <span>{label(options.at(-1)!.reasoningEffort)}</span>
                      </div>
                      {index < 0 && (
                        <p className="agent-model-note">
                          {t("此模型不支持已保存的强度，请选择新档位。")}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="agent-model-note">
                      {current
                        ? t("此模型未提供可调思考强度。")
                        : t("选择模型以查看可用思考强度。")}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
