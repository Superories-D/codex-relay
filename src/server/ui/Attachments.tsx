import React, { useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../../shared/types";
import { t, errorText } from "../../renderer/i18n";
export const attachmentKey = (id: string) => `relay.remote.attachments.${id}`;
export function readAttachments(id: string): ChatAttachment[] {
  try {
    return JSON.parse(sessionStorage.getItem(attachmentKey(id)) || "[]");
  } catch {
    return [];
  }
}
export function saveAttachments(id: string, value: ChatAttachment[]) {
  sessionStorage.setItem(attachmentKey(id), JSON.stringify(value));
}
export function RemoteAttachments({
  id,
  token,
  value,
  disabled,
  onChange,
  onBusy,
}: {
  id: string;
  token: string;
  value: ChatAttachment[];
  disabled: boolean;
  onChange: (files: ChatAttachment[]) => void;
  onBusy: (busy: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    latest = useRef(value),
    locked = useRef(false);
  latest.current = value;
  const [error, setError] = useState(""),
    [uploading, setUploading] = useState(false);
  const pendingKey = attachmentKey(id) + ".pending";
  async function receive(fileId: string, name: string, file?: File) {
    const endpoint = `/api/uploads/${fileId}`,
      headers = { Authorization: `Bearer ${token}` };
    let response: Response;
    try {
      response = await fetch(
        endpoint + (file ? `?name=${encodeURIComponent(name)}` : ""),
        file
          ? {
              method: "POST",
              headers: {
                ...headers,
                "Content-Type": "application/octet-stream",
              },
              body: file,
              signal: AbortSignal.timeout(60000),
            }
          : { headers, signal: AbortSignal.timeout(15000) },
      );
    } catch (e) {
      if (!file) throw e;
      response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    }
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Upload failed");
    if (!alive.current) return;
    const next = [
      ...latest.current.filter((a) => a.path !== data.result.attachment.path),
      data.result.attachment,
    ];
    saveAttachments(id, next);
    latest.current = next;
    onChange(next);
    sessionStorage.removeItem(pendingKey);
  }
  async function upload(files: File[]) {
    if (disabled || locked.current || !files.length) return;
    if (
      latest.current.length + files.length > 10 ||
      files.some((f) => f.size > 8 * 1024 * 1024)
    ) {
      setError("最多 10 个附件，单个最大 8 MiB");
      return;
    }
    locked.current = true;
    setUploading(true);
    onBusy(true);
    setError("");
    try {
      for (const file of files) {
        if (!alive.current) break;
        const fileId = crypto.randomUUID();
        sessionStorage.setItem(
          pendingKey,
          JSON.stringify({ id: fileId, name: file.name }),
        );
        await receive(fileId, file.name, file);
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      locked.current = false;
      if (alive.current) {
        setUploading(false);
        onBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      if (pending) {
        locked.current = true;
        setUploading(true);
        onBusy(true);
        void receive(pending.id, pending.name)
          .catch(() => {
            if (alive.current) setError("上次上传尚未确认，请重新选择文件。");
          })
          .finally(() => {
            locked.current = false;
            if (alive.current) {
              setUploading(false);
              onBusy(false);
            }
          });
      }
    } catch {}
    return () => {
      alive.current = false;
      onBusy(false);
    };
  }, [id, token]);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (
        root.current?.closest("form")?.contains(event.target as Node) &&
        event.clipboardData?.files.length
      ) {
        event.preventDefault();
        void upload(Array.from(event.clipboardData.files));
      }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  return (
    <div
      ref={root}
      className="remote-attachments"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      <label>
        {t("附件")} · {uploading ? "上传中…" : "拖入文件 / 粘贴图片"}
        <input
          type="file"
          multiple
          disabled={disabled || uploading}
          onChange={(e) => {
            void upload(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </label>
      {value.map((file) => (
        <div key={file.path}>
          <span>{file.name}</span>
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => {
              try {
                const next = latest.current.filter((a) => a.path !== file.path);
                saveAttachments(id, next);
                latest.current = next;
                onChange(next);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t("移除")}
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
