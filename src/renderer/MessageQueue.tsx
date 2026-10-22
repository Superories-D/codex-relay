import React, { useState } from "react";
import type { Job } from "../shared/types";
import { t, useI18n } from "./i18n";

export function MessageQueue({
  job,
  pending,
  onChange,
}: {
  job: Job;
  pending: boolean;
  onChange: (args: {
    id: string;
    messageId: string;
    revision: number;
    action: "edit" | "remove" | "up" | "down";
    text?: string;
  }) => void;
}) {
  useI18n();
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState("");
  if (!job.queuedMessages?.length) return null;
  return (
    <details className="message-queue" open>
      <summary>
        {t("待发送队列")} · {job.queuedMessages.length}
      </summary>
      <ol>
        {job.queuedMessages.map((message, index) => {
          const change = (
            action: "edit" | "remove" | "up" | "down",
            value?: string,
          ) =>
            onChange({
              id: job.id,
              messageId: message.id!,
              revision: job.queueRevision || 0,
              action,
              text: value,
            });
          return (
            <li key={message.id || index}>
              {editing === message.id ? (
                <textarea
                  aria-label={t("编辑排队消息")}
                  value={text}
                  maxLength={100000}
                  onChange={(e) => setText(e.target.value)}
                />
              ) : (
                <p>{message.text}</p>
              )}
              {!!message.attachments.length && (
                <small>
                  {t("附件")} · {message.attachments.length}
                </small>
              )}
              <div className="queue-actions">
                {editing === message.id ? (
                  <>
                    <button
                      disabled={pending || !text.trim()}
                      onClick={() => {
                        change("edit", text);
                        setEditing(undefined);
                      }}
                    >
                      {t("保存")}
                    </button>
                    <button onClick={() => setEditing(undefined)}>
                      {t("取消")}
                    </button>
                  </>
                ) : (
                  <button
                    disabled={pending || !message.id}
                    onClick={() => {
                      setEditing(message.id);
                      setText(message.text);
                    }}
                  >
                    {t("编辑")}
                  </button>
                )}
                <button
                  disabled={pending || index === 0 || !message.id}
                  onClick={() => change("up")}
                >
                  {t("上移")}
                </button>
                <button
                  disabled={
                    pending ||
                    index === job.queuedMessages!.length - 1 ||
                    !message.id
                  }
                  onClick={() => change("down")}
                >
                  {t("下移")}
                </button>
                <button
                  disabled={pending || !message.id}
                  onClick={() => change("remove")}
                >
                  {t("移除")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
