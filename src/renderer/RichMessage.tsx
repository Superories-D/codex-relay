import { t, useI18n } from "./i18n";
import { sameChatItem } from "./chat-view";
import React, { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  Globe,
  LoaderCircle,
  Network,
  SquareTerminal,
  Sparkles,
} from "lucide-react";
import type { ChatItem } from "../shared/types";

export function MarkdownText({
  text,
  onOpen,
}: {
  text: string;
  onOpen?: (path: string) => void;
}) {
  useI18n();

  return (
    <div className="rich-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <button
              className="markdown-link"
              onClick={() => {
                if (!href) return;
                if (/^https?:\/\//i.test(href))
                  void window.relay.command("link.open", href);
                else
                  onOpen?.(
                    decodeURIComponent(href).replace(/:\d+(?::\d+)?$/, ""),
                  );
              }}
            >
              {children}
            </button>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ alt }) => (
            <span className="markdown-image">
              {t("图片 ·")}
              {alt || t("附件")}
            </span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
function CodeBlock({ children }: { children?: React.ReactNode }) {
  useI18n();

  const [copied, setCopied] = useState(false);
  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  return (
    <div className="code-block">
      <div>
        <span>
          {child?.props?.className?.match(/language-(\S+)/)?.[1] || t("代码")}
        </span>
        <button
          title={t("复制代码")}
          onClick={(e) => {
            const text =
              e.currentTarget.closest(".code-block")?.querySelector("pre")
                ?.textContent || "";
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("已复制") : t("复制代码")}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
function RichMessageView({
  item,
  onOpen,
  onAgents,
  onChanges,
  onSource,
}: {
  item: ChatItem;
  onOpen: (path: string) => void;
  onAgents: () => void;
  onChanges: () => void;
  onSource?: () => void;
}) {
  useI18n();

  const [copied, setCopied] = useState(false);
  if (item.role === "tool") {
    const agent = ["collabAgentToolCall", "subAgentActivity"].includes(
      item.kind,
    );
    const files = item.kind === "fileChange" || item.kind === "diff";
    const reasoning = item.kind === "reasoning";
    const plan = item.kind === "plan";
    const Icon = agent
      ? Network
      : files
        ? FileCode2
        : item.kind === "webSearch"
          ? Globe
          : reasoning || plan
            ? Sparkles
            : SquareTerminal;
    let paths: string[] = [];
    if (files && Array.isArray(item.data?.changes))
      paths = item.data.changes.map((c: any) => c.path);
    const status = item.status === "running";
    return (
      <div
        className={`activity-item ${files ? "change-card" : ""} ${agent ? "agent-card" : ""}`}
      >
        <details>
          <summary>
            <span className="activity-icon">
              {status ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Icon size={16} />
              )}
            </span>
            <span>
              {reasoning
                ? t("思考过程")
                : files
                  ? paths.length
                    ? t("已编辑 {p0} 个文件", { p0: paths.length })
                    : t("文件变更")
                  : agent
                    ? item.text
                    : plan
                      ? t("执行计划")
                      : item.text.slice(0, 180)}
            </span>
            <span className="activity-status">
              {status ? t("进行中") : item.status === "failed" ? t("失败") : ""}
            </span>
            <ChevronDown size={14} />
          </summary>
          {files && paths.length ? (
            <div className="change-file-list">
              {paths.map((p) => (
                <button key={p} onClick={() => onOpen(p)}>
                  <FileCode2 size={14} />
                  <span>{p}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          ) : null}
          {reasoning || plan ? (
            <MarkdownText
              text={item.text || item.detail || ""}
              onOpen={onOpen}
            />
          ) : (
            <pre>{item.detail || item.text}</pre>
          )}
        </details>
        {item.sourceTruncated && (
          <div className="source-truncated-note">
            <span>{t("超长内容显示预览，完整内容已保留在原始记录中。")}</span>
            {onSource && (
              <button onClick={onSource}>{t("查看完整原始记录")}</button>
            )}
          </div>
        )}
        {files && (
          <button className="activity-action" onClick={onChanges}>
            {t("查看更改")}
            <ChevronRight size={13} />
          </button>
        )}
        {agent && (
          <button className="activity-action" onClick={onAgents}>
            {t("查看子代理")}
            <ChevronRight size={13} />
          </button>
        )}
      </div>
    );
  }
  return (
    <article className={`agent-message ${item.role}`}>
      {item.sourceTruncated && (
        <div className="source-truncated-note">
          <span>{t("超长内容显示预览，完整内容已保留在原始记录中。")}</span>
          {onSource && (
            <button onClick={onSource}>{t("查看完整原始记录")}</button>
          )}
        </div>
      )}
      <MarkdownText text={item.text} onOpen={onOpen} />
      {item.detail && (
        <div className="message-attachments">
          {item.detail
            .split("\n")
            .filter(Boolean)
            .map((p) => (
              <button key={p} onClick={() => onOpen(p)}>
                <FileCode2 size={14} />
                {p.split(/[\\/]/).at(-1)}
              </button>
            ))}
        </div>
      )}
      {item.role === "assistant" && (
        <div className="message-actions">
          <button
            aria-label={t("复制回答")}
            title={t("复制回答")}
            onClick={() =>
              void navigator.clipboard.writeText(item.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              })
            }
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      )}
    </article>
  );
}
export const RichMessage = React.memo(RichMessageView, (previous, next) =>
  sameChatItem(previous.item, next.item),
);
