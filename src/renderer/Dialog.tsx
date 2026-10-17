import { t, useI18n } from "./i18n";
import React, { useEffect, useRef } from "react";
export function Dialog({
  title,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useI18n();

  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const locked = useRef(busy);
  locked.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const nodes = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ) ?? [],
      ).filter((x) => x.getClientRects().length > 0);
    (
      ref.current?.querySelector<HTMLElement>(
        "input:not([disabled]),textarea:not([disabled]),select:not([disabled])",
      ) ??
      nodes()[0] ??
      ref.current
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked.current) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key === "Tab") {
        const all = nodes();
        if (!all.length) {
          e.preventDefault();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === all[0] ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          all.at(-1)?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === all.at(-1) ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          all[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <button
          className="modal-close"
          aria-label={t("关闭")}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
        {children}
      </section>
    </div>
  );
}
