// Keep scroll writes local to the transcript. Layout changes must not be
// mistaken for the reader choosing to leave the latest message.
export function followChat(
  viewport: HTMLElement,
  content: HTMLElement,
  following: { current: boolean },
  changed: (away: boolean) => void,
  restoreTop?: number,
) {
  const size = () => [
    viewport.clientWidth,
    viewport.clientHeight,
    viewport.scrollHeight,
  ];
  let measured = size(),
    frame = 0,
    closed = false;
  let jump: { started: number; from: number } | undefined;
  const gap = () =>
    Math.max(
      0,
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
    );
  const notify = () => changed(!following.current && gap() > 32);
  const cancelJump = () => {
    jump = undefined;
  };
  const pause = () => {
    cancelJump();
    restoreTop = undefined;
    following.current = false;
  };
  const schedule = () => {
    if (!frame && !closed) frame = requestAnimationFrame(update);
  };
  function update(now: number) {
    frame = 0;
    if (closed) return;
    measured = size();
    if (!following.current && restoreTop !== undefined) {
      const available = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight,
      );
      viewport.scrollTop = Math.min(restoreTop, available);
      // The selected chat can still be rendering the previous short page.
      // Keep the target until its cached/native history has room to restore it.
      if (available >= restoreTop - 4) restoreTop = undefined;
    }
    if (following.current) {
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (jump) {
        const progress = Math.min(1, (now - jump.started) / 240);
        viewport.scrollTop =
          jump.from + (target - jump.from) * (1 - (1 - progress) ** 3);
        if (progress < 1) schedule();
        else cancelJump();
      } else viewport.scrollTop = target;
    }
    notify();
  }
  const scrolled = () => {
    if (
      restoreTop === undefined &&
      !jump &&
      size().every((n, i) => n === measured[i])
    ) {
      // Upward gestures detach even within the normal follow tolerance.
      // Reattach only once that reader returns to the actual end.
      following.current = gap() <= (following.current ? 100 : 4);
    }
    notify();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0) pause();
  };
  let touchY = 0;
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY || 0;
  };
  const touchMove = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY ?? touchY;
    if (next > touchY) pause();
    touchY = next;
  };
  const pointer = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (
      target.closest("summary") ||
      (target === viewport &&
        event.clientX >=
          viewport.getBoundingClientRect().right -
            (viewport.offsetWidth - viewport.clientWidth))
    )
      pause();
  };
  const key = (event: KeyboardEvent) => {
    if (
      (event.target as HTMLElement).closest(
        "input, textarea, [contenteditable=true]",
      )
    )
      return;
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
      (event.key === " " && event.shiftKey) ||
      (["Enter", " "].includes(event.key) &&
        (event.target as HTMLElement).closest("summary"))
    )
      pause();
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(viewport);
  observer.observe(content);
  viewport.addEventListener("scroll", scrolled, { passive: true });
  viewport.addEventListener("wheel", wheel, { passive: true });
  viewport.addEventListener("touchstart", touchStart, { passive: true });
  viewport.addEventListener("touchmove", touchMove, { passive: true });
  viewport.addEventListener("pointerdown", pointer);
  viewport.addEventListener("keydown", key);
  schedule();
  return {
    latest() {
      restoreTop = undefined;
      following.current = true;
      const reduced =
        matchMedia("(prefers-reduced-motion: reduce)").matches ||
        !!viewport.closest(".reduce-motion");
      jump = reduced
        ? undefined
        : { started: performance.now(), from: viewport.scrollTop };
      schedule();
    },
    destroy() {
      closed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", scrolled);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("pointerdown", pointer);
      viewport.removeEventListener("keydown", key);
    },
  };
}
