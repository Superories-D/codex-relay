import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { t, useI18n } from "./i18n";
import { copyText } from "./clipboard";

export function CopyButton({
  text,
  label,
  iconOnly = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) {
  useI18n();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const message =
    status === "copied"
      ? t("已复制")
      : status === "failed"
        ? t("复制失败，点击重试")
        : label;
  const Icon =
    status === "copied" ? Check : status === "failed" ? RotateCcw : Copy;
  return (
    <button
      className="copy-button"
      aria-label={message}
      title={message}
      onClick={async () => {
        clearTimeout(timer.current);
        try {
          await copyText(text);
          setStatus("copied");
          timer.current = setTimeout(() => setStatus("idle"), 1800);
        } catch {
          setStatus("failed");
        }
      }}
    >
      <Icon size={iconOnly ? 15 : 13} aria-hidden="true" />
      {!iconOnly && <span>{message}</span>}
      <span className="copy-announcement" role="status" aria-live="polite">
        {status === "idle" ? "" : message}
      </span>
    </button>
  );
}
