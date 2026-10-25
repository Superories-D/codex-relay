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
    // CSS viewport units do not shrink with an ancestor's CSS zoom. Fit the
    // top-layer dialog in logical pixels while retaining the enlarged text.
    const fit = () => {
      let zoom = 1;
      for (let node: HTMLElement | null = element; node; node = node.parentElement)
        zoom *= Number.parseFloat(getComputedStyle(node).zoom) || 1;
      const width = window.innerWidth / zoom, height = window.innerHeight / zoom;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      if (content.current) {
        const style = getComputedStyle(element);
        content.current.style.maxWidth = `${Math.max(1, width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))}px`;
        content.current.style.maxHeight = `${Math.max(1, Math.min(height * .9, height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)))}px`;
        content.current.style.setProperty("--dialog-available-height",content.current.style.maxHeight);
      }
    };
    fit();
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    const observer = new MutationObserver(fit);
    for (let node = element.parentElement; node; node = node.parentElement)
      observer.observe(node, {attributes: true, attributeFilter: ["style", "class"]});
    (
      content.current?.querySelector<HTMLElement>(
        "input:not([disabled]),textarea:not([disabled]),select:not([disabled])",
      ) || content.current
    )?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
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
