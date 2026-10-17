import { t, useI18n } from "./i18n";
import React, { useContext, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DialogPresenceContext } from "./MotionRegion";

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
  const leaving = useContext(DialogPresenceContext);
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    (
      content.current?.querySelector<HTMLElement>(
        "input:not([disabled]),textarea:not([disabled]),select:not([disabled])",
      ) || content.current
    )?.focus();
    return () => {
      element.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="modal-shade"
      aria-label={title}
      aria-modal="true"
      data-leaving={leaving}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && !leaving) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !leaving)
          onClose();
      }}
    >
      <section ref={content} className="modal" tabIndex={-1} inert={leaving}>
        <button
          className="modal-close"
          aria-label={t("关闭")}
          disabled={busy || leaving}
          onClick={onClose}
        >
          ×
        </button>
        {children}
      </section>
    </dialog>,
    document.querySelector(".desktop-shell") ||
      document.querySelector(".app-shell") ||
      document.body,
  );
}
