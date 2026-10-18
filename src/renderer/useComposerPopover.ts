import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

// Keep footer popovers above the input, including after wrapping, zoom and resize.
export function useComposerPopover(
  root: RefObject<HTMLDivElement | null>,
  open: boolean,
  width: number,
) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const anchor = root.current;
    const composer = anchor.closest(".composer-controls")?.querySelector(".agent-composer");
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const top = composer?.getBoundingClientRect().top ?? rect.top;
      const availableWidth = Math.min(width, window.innerWidth - 24);
      setStyle({
        position: "fixed",
        width: availableWidth,
        left: Math.max(12, Math.min(rect.right - availableWidth, window.innerWidth - availableWidth - 12)),
        right: "auto",
        bottom: window.innerHeight - Math.max(20, top) + 8,
        maxHeight: Math.max(0, top - 20),
        visibility: "visible",
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (composer) observer.observe(composer);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [root, open, width]);
  return style;
}
