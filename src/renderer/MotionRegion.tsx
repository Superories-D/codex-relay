import React, { createContext, useEffect, useRef, useState } from "react";

export const DialogPresenceContext = createContext(false);
export function ModalPresence({
  children,
  onExitComplete,
}: {
  children: React.ReactNode;
  onExitComplete?: () => void;
}) {
  const previous = useRef(children);
  if (children) previous.current = children;
  const present = usePresence(!!children);
  const shown = useRef(present),
    exited = useRef(onExitComplete);
  exited.current = onExitComplete;
  useEffect(() => {
    if (present) shown.current = true;
    else if (shown.current) {
      shown.current = false;
      exited.current?.();
    }
  }, [present]);
  return present ? (
    <DialogPresenceContext.Provider value={!children}>
      {children || previous.current}
    </DialogPresenceContext.Provider>
  ) : null;
}

// Keep a closing surface around just long enough to finish its exit, without
// leaving focusable controls or active subscriptions behind after the transition.
export function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const reduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !!document.querySelector(".desktop-shell.reduce-motion");
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : 230);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

export function MotionRegion({
  open,
  axis,
  preview = false,
  children,
}: {
  open: boolean;
  axis: "horizontal" | "vertical";
  preview?: boolean;
  children: React.ReactNode;
}) {
  const mounted = usePresence(open);
  return (
    <div
      className={`motion-region ${axis} ${preview ? "preview" : ""}`}
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      {mounted && <div className="motion-region-content">{children}</div>}
    </div>
  );
}
