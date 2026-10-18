import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import type { Job } from "../shared/types";
import { t, useI18n } from "./i18n";
import { useComposerPopover } from "./useComposerPopover";

const options = [
  ["workspaceWrite", "请求审批"],
  ["readOnly", "只读"],
  ["dangerFullAccess", "完全访问"],
] as const;

export function PermissionPicker({ value, native, disabled, onChange }: {
  value: Job["sandbox"] | "native";
  native: boolean;
  disabled: boolean;
  onChange: (value: Job["sandbox"]) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const style = useComposerPopover(root, open, 220);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open || style.visibility !== "visible") return;
    const menu = root.current?.querySelector<HTMLElement>('[role="menu"]');
    (menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ??
      menu?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, style.visibility]);
  const close = () => {
    setOpen(false);
    root.current?.querySelector<HTMLButtonElement>(".permission-trigger")?.focus();
  };
  return (
    <div className="permission-picker" ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}>
      <button
        className="permission-trigger"
        aria-label={t("执行权限")}
        title={t("执行权限")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ShieldCheck size={14} />
        <span>{value === "native" ? t("沿用原生权限") : t(options.find(([key]) => key === value)?.[1] || "请求审批")}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="permission-menu" role="menu" aria-label={t("执行权限")} style={style}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key === "Tab") close();
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
                (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          <div className="composer-menu-label">{t("执行权限")}</div>
          {native && <button role="menuitemradio" aria-checked={value === "native"} disabled>{t("沿用原生权限")}</button>}
          {options.map(([key, name]) => (
            <button key={key} role="menuitemradio" aria-checked={value === key}
              onClick={() => { onChange(key); close(); }}>
              <span>{t(name)}</span>{value === key && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
