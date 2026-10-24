import { t, useI18n } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import { usePresence } from "./MotionRegion";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Zap,
} from "lucide-react";
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
  const popoverStyle = useComposerPopover(root, open, 256);
  const modelButton = useRef<HTMLButtonElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const previousList = useRef(false);
  const previousOpen = useRef(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [list, setList] = useState(false);
  const defaultModel = models.find((m) => m.isDefault);
  const current =
    models.find((m) => m.model === model || m.id === model) ??
    (!model ? models.find((m) => m.isDefault) : undefined);
  const options = current?.supportedReasoningEfforts ?? [];
  const value = effort || current?.defaultReasoningEffort || "";
  const index = options.findIndex((o) => o.reasoningEffort === value);
  const fraction = Math.max(0, index) / Math.max(1, options.length - 1);
  const name = current?.displayName || model || t("默认模型");
  const strength = value ? label(value) : t("默认强度");

  const choose = (option: ModelOption, useDefault = false) => {
    onChange(
      useDefault ? "" : option.model,
      option.supportedReasoningEfforts.some((o) => o.reasoningEffort === value)
        ? value
        : option.defaultReasoningEffort,
    );
    setList(false);
  };

  useEffect(() => {
    if (!open) {
      previousList.current = false;
      return;
    }
    const popup = root.current?.querySelector<HTMLElement>(
      ".agent-model-popover",
    );
    if (list) {
      const selected = modelList.current?.querySelector<HTMLButtonElement>(
        '[aria-pressed="true"]',
      );
      if (!modelList.current?.contains(document.activeElement)) {
        (
          selected ??
          modelList.current?.querySelector<HTMLButtonElement>("button")
        )?.focus();
      }
    } else if (previousList.current) {
      modelButton.current?.focus();
    } else if (!popup?.contains(document.activeElement)) {
      (
        popup?.querySelector<HTMLElement>("input:not(:disabled)") ??
        popup?.querySelector<HTMLElement>("button:not(:disabled)") ??
        popup
      )?.focus();
    }
    previousList.current = list;
  }, [open, list, loading, models, error]);

  useEffect(() => {
    const opening = open && !previousOpen.current;
    previousOpen.current = open;
    // A catalog read may fail while startup is installing the CLI. Reopening
    // retries once; errors while open still require an explicit retry.
    if (opening && error) setRetry((n) => n + 1);
  }, [open, error]);

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
        if (list) {
          setList(false);
          return;
        }
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
  }, [open, list, setOpen]);

  return (
    <div className="agent-model-picker" ref={root}>
      <button
        className="agent-model-trigger"
        aria-label={t("选择模型和思考强度")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="agent-model-current">{name}</span>
        <span className="agent-model-strength">{strength}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {present && (
        <div
          className="agent-model-popover"
          data-view={list ? "models" : "effort"}
          style={popoverStyle}
          data-open={open}
          inert={!open}
          aria-hidden={!open}
          role="dialog"
          tabIndex={-1}
          aria-label={t("模型和思考强度")}
        >
          {list ? (
            <div className="agent-model-list-heading">
              <span>{t("选择模型")}</span>
              <button
                aria-label={t("返回思考强度")}
                onClick={() => setList(false)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <div className="agent-model-heading" aria-label={t("思考强度")}>
                <Zap
                  className="agent-model-bolt"
                  size={16}
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                <strong aria-live="polite">{strength}</strong>
                <button
                  aria-label={t("重置思考强度")}
                  title={t("恢复此模型的默认思考强度")}
                  disabled={!current}
                  onClick={() =>
                    onChange(model, current!.defaultReasoningEffort)
                  }
                >
                  <RotateCcw size={16} strokeWidth={1.7} aria-hidden="true" />
                </button>
              </div>
              <button
                className="agent-model-name"
                ref={modelButton}
                aria-expanded={list}
                disabled={loading || !models.length}
                onClick={() => setList(true)}
              >
                {name}
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            </>
          )}
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
                  ref={modelList}
                  role="group"
                  aria-label={t("可用模型")}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const buttons = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        "button",
                      ),
                    );
                    const at = buttons.indexOf(
                      document.activeElement as HTMLButtonElement,
                    );
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (at +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              buttons.length) %
                            buttons.length;
                    buttons[next]?.focus();
                  }}
                >
                  {defaultModel && (
                    <button
                      className="agent-model-default"
                      aria-pressed={!model}
                      onClick={() => choose(defaultModel, true)}
                    >
                      <span>
                        {t("默认")}
                        <small>
                          {defaultModel.displayName || defaultModel.model}
                        </small>
                      </span>
                      {!model && <Check size={17} aria-hidden="true" />}
                    </button>
                  )}
                  {models
                    .filter((m) => !m.hidden || m === current)
                    .map((m) => (
                      <button
                        key={m.id}
                        className={model && m === current ? "selected" : ""}
                        aria-pressed={!!model && m === current}
                        title={m.description || undefined}
                        onClick={() => choose(m)}
                      >
                        <span>{m.displayName || m.model}</span>
                        {!!model && m === current && (
                          <Check size={17} aria-hidden="true" />
                        )}
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
                            "--effort-fill": `calc(${14 - 28 * fraction}px + ${fraction * 100}%)`,
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
                              model,
                              options[Number(e.target.value)].reasoningEffort,
                            )
                          }
                        />
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
