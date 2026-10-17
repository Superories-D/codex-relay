import { ModalPresence } from "./MotionRegion";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import type { ChatImage } from "../shared/types";
import { t, useI18n } from "./i18n";
import { Dialog } from "./Dialog";

export const MediaContext = createContext<{
  id?: string;
  threadId?: string;
  cwd?: string;
}>({});
const thumbnails = new Map<string, Promise<any>>();
function readImage(
  context: React.ContextType<typeof MediaContext>,
  file: string,
  thumbnail: boolean,
) {
  const args = { ...context, path: file, thumbnail };
  const key = JSON.stringify(args);
  if (!thumbnail)
    return window.relay.command("chat.asset.read", args) as Promise<any>;
  let pending = thumbnails.get(key);
  if (!pending) {
    pending = window.relay.command("chat.asset.read", args).catch((error) => {
      thumbnails.delete(key);
      throw error;
    });
    thumbnails.set(key, pending);
    while (thumbnails.size > 120)
      thumbnails.delete(thumbnails.keys().next().value!);
  }
  return pending;
}
export function ImageThumbnail({
  image,
  compact = false,
  context: provided,
}: {
  image: ChatImage;
  compact?: boolean;
  context?: React.ContextType<typeof MediaContext>;
}) {
  useI18n();
  const inherited = useContext(MediaContext),
    context = provided || inherited;
  const [source, setSource] = useState(""),
    [failed, setFailed] = useState(false),
    [open, setOpen] = useState(false);
  const host = useRef<HTMLButtonElement>(null);
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    let alive = true;
    setSource("");
    setFailed(false);
    const load = () => {
      if (image.url) {
        setSource(image.url);
        return;
      }
      if (image.data) {
        setSource(image.data);
        return;
      }
      if (!image.path) {
        setFailed(true);
        return;
      }
      void readImage(context, image.path, true)
        .then((value) => {
          if (alive)
            value?.kind === "image"
              ? setSource(value.content)
              : setFailed(true);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "160px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [image.path, image.data, image.url, contextKey]);
  return (
    <>
      <button
        ref={host}
        className={`chat-image-thumbnail ${compact ? "compact" : ""} ${failed ? "unavailable" : ""}`}
        aria-label={t("查看图片 {p0}", { p0: image.name })}
        title={failed ? t("图片文件已移动或无法读取") : image.name}
        onClick={() => setOpen(true)}
      >
        {source ? (
          <img
            src={source}
            alt={image.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => {
              setFailed(true);
              setSource("");
            }}
          />
        ) : failed ? (
          <ImageIcon size={compact ? 16 : 25} />
        ) : (
          <LoaderCircle size={compact ? 14 : 20} className="spin" />
        )}
        {!compact && (
          <span className="image-enlarge">
            <Maximize2 size={14} />
          </span>
        )}
      </button>
      <ModalPresence>
        {open && (
          <ImageViewer
            image={image}
            context={context}
            close={() => setOpen(false)}
          />
        )}
      </ModalPresence>
    </>
  );
}
function ImageViewer({
  image,
  context,
  close,
}: {
  image: ChatImage;
  context: React.ContextType<typeof MediaContext>;
  close: () => void;
}) {
  useI18n();
  const [source, setSource] = useState(image.data || image.url || ""),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [dragging, setDragging] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | {
        pointerId: number;
        x: number;
        y: number;
        left: number;
        top: number;
      }
    | undefined
  >(undefined);
  const fit = natural.width
    ? Math.min(
        1,
        Math.max(1, viewport.width - 28) / natural.width,
        Math.max(1, viewport.height - 28) / natural.height,
      )
    : 1;
  const width = Math.max(1, natural.width * fit * zoom),
    height = Math.max(1, natural.height * fit * zoom);
  const overflow = width > viewport.width || height > viewport.height;
  useEffect(() => {
    const node = canvas.current!;
    const observer = new ResizeObserver(() =>
      setViewport({ width: node.clientWidth, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (image.data || image.url) return;
    let alive = true;
    if (!image.path) setError(t("图片文件已移动或无法读取"));
    else
      void readImage(context, image.path, false)
        .then((value) => {
          if (alive)
            value.kind === "image"
              ? setSource(value.content)
              : setError(t("图片文件已移动或无法读取"));
        })
        .catch(() => {
          if (alive) setError(t("图片文件已移动或无法读取"));
        });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Dialog title={image.name} onClose={close}>
      <div className="image-viewer-toolbar">
        <button
          aria-label={t("缩小图片")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label={t("放大图片")}
          disabled={zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          <Plus size={16} />
        </button>
        <button aria-label={t("重置缩放")} onClick={() => setZoom(1)}>
          <RotateCcw size={15} />
        </button>
        {(image.path || image.url) && (
          <button
            className="image-open-original"
            onClick={() =>
              void window.relay
                .command(
                  image.url ? "link.open" : "chat.asset.open",
                  image.url || { ...context, path: image.path },
                )
                .catch(() => setError(t("图片文件已移动或无法读取")))
            }
          >
            <ExternalLink size={14} />
            {image.url ? t("在浏览器中打开") : t("在默认应用中打开")}
          </button>
        )}
      </div>
      <div
        ref={canvas}
        className={`image-viewer-canvas ${overflow ? "pannable" : ""} ${dragging ? "dragging" : ""}`}
        tabIndex={0}
        aria-label={t("图片画布")}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            setZoom((value) => Math.min(3, value + 0.25));
          } else if (event.key === "-") {
            event.preventDefault();
            setZoom((value) => Math.max(0.5, value - 0.25));
          } else if (event.key === "0") {
            event.preventDefault();
            setZoom(1);
          }
        }}
        onPointerDown={(event) => {
          if (!overflow || event.button !== 0 || event.pointerType === "touch")
            return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            drag.current = undefined;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
      >
        {error ? (
          <p role="alert">{error}</p>
        ) : source ? (
          <div
            className="image-viewer-stage"
            style={{
              width: Math.max(viewport.width, width + 28),
              height: Math.max(viewport.height, height + 28),
            }}
          >
            <img
              src={source}
              alt={image.name}
              referrerPolicy="no-referrer"
              draggable={false}
              style={{ width, height }}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setError(t("图片暂时无法加载"))}
            />
          </div>
        ) : (
          <LoaderCircle className="spin" size={24} />
        )}
      </div>
    </Dialog>
  );
}
export function ImageGallery({ images }: { images: ChatImage[] }) {
  return (
    <div className="chat-image-gallery">
      {images.map((image) => (
        <ImageThumbnail key={image.id} image={image} />
      ))}
    </div>
  );
}
