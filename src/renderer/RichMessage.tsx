import { t, useI18n } from "./i18n";
import { sameChatItem } from "./chat-view";
import React, { useId, useMemo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  normalizeMessage,
  nodeText,
  mathSource,
  decodeFileLink,
} from "./message-format";
import { CopyButton } from "./CopyButton";
import type { PluggableList } from "unified";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Globe,
  LoaderCircle,
  Network,
  SquareTerminal,
  Sparkles,
  Image as ImageIcon,
  Target,
} from "lucide-react";
import type { ChatItem } from "../shared/types";
import { ImageGallery, ImageThumbnail } from "./ChatImages";
const remarkPlugins: PluggableList = [remarkGfm, remarkMath];
const rehypePlugins: PluggableList = [
  [
    rehypeKatex,
    { trust: false, maxExpand: 1000, maxSize: 20, strict: "ignore" },
  ],
  [rehypeHighlight, { detect: false }],
];

export function MarkdownText({
  text,
  onOpen,
  streaming = false,
}: {
  text: string;
  onOpen?: (path: string) => void;
  streaming?: boolean;
}) {
  useI18n();
  const id = useId();
  const formatted = useMemo(
    () => normalizeMessage(text, streaming),
    [text, streaming],
  );

  return (
    <div className="rich-markdown">
      <Markdown
        urlTransform={(url, key) =>
          /^[A-Za-z]:[\\/]/.test(url) ||
          (key === "src" &&
            /^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/i.test(url))
            ? url
            : defaultUrlTransform(url)
        }
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={{
          clobberPrefix: `message-${id}-`,
          footnoteLabel: t("注释"),
          footnoteBackLabel: t("返回正文"),
        }}
        components={{
          a: ({ href, children, node: _node, ...props }) =>
            href?.startsWith("#") ? (
              <a
                {...props}
                className="markdown-link"
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  const target = document.getElementById(href.slice(1));
                  if (!target) return;
                  const reduced =
                    window.matchMedia("(prefers-reduced-motion: reduce)")
                      .matches ||
                    !!document.querySelector(".desktop-shell.reduce-motion");
                  target.scrollIntoView({
                    block: "nearest",
                    behavior: reduced ? "instant" : "smooth",
                  });
                  target.tabIndex = -1;
                  target.focus({ preventScroll: true });
                }}
              >
                {children}
              </a>
            ) : (
              <button
                id={props.id}
                className="markdown-link"
                onClick={() => {
                  if (!href) return;
                  if (/^https?:\/\//i.test(href))
                    void window.relay.command("link.open", href);
                  else if (href)
                    onOpen?.(
                      decodeFileLink(href).replace(/:\d+(?::\d+)?$/, ""),
                    );
                }}
              >
                {children}
              </button>
            ),
          pre: ({ node, children }) => (
            <CodeBlock source={nodeText(node).replace(/\n$/, "")}>
              {children}
            </CodeBlock>
          ),
          span: ({ node, className, children, ...props }) => {
            if (className?.split(" ").includes("katex-display"))
              return (
                <div className="math-block">
                  <span {...props} className={className}>
                    {children}
                  </span>
                  <CopyButton
                    text={mathSource(node)}
                    label={t("复制公式")}
                    iconOnly
                  />
                </div>
              );
            return (
              <span {...props} className={className}>
                {children}
              </span>
            );
          },
          img: ({ alt, src }) =>
            typeof src === "string" && !/^http:/i.test(src) ? (
              <ImageThumbnail
                image={{
                  id: src,
                  origin: "generated",
                  name: alt || t("图片"),
                  ...(/^https:\/\//i.test(src)
                    ? { url: src }
                    : /^data:image\//.test(src)
                      ? { data: src }
                      : { path: decodeFileLink(src) }),
                }}
              />
            ) : (
              <span className="markdown-image">
                {t("图片 ·")}
                {alt || t("附件")}
              </span>
            ),
        }}
      >
        {formatted}
      </Markdown>
    </div>
  );
}
function CodeBlock({
  children,
  source,
}: {
  children?: React.ReactNode;
  source: string;
}) {
  useI18n();

  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  return (
    <div className="code-block">
      <div>
        <span>
          {child?.props?.className?.match(/language-(\S+)/)?.[1] || t("代码")}
        </span>
        <CopyButton text={source} label={t("复制代码")} />
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

  if (item.kind === "goal" && item.role === "system")
    return (
      <div className="goal-history-note">
        <Target size={14} />
        <span>{t("会话目标已更新")}</span>
      </div>
    );
  if (item.role === "tool") {
    if (
      item.images?.length ||
      ["imageView", "imageGeneration"].includes(item.kind)
    ) {
      const generated =
        item.kind === "imageGeneration" ||
        item.images?.some((image) => image.origin === "generated");
      const busy = ["running", "inProgress", "in_progress"].includes(
        item.status || "",
      );
      const failed = item.status === "failed" || !!item.data?.failure;
      return (
        <div className="image-activity">
          <details open>
            <summary>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ImageIcon size={16} />
              )}
              <span>
                {failed
                  ? t("图片操作失败")
                  : busy
                    ? generated
                      ? t("正在生成图片…")
                      : t("正在查看图片…")
                    : generated
                      ? t("已生成 {p0} 张图片", {
                          p0: item.images?.length || 0,
                        })
                      : t("已查看 {p0} 张图像", {
                          p0: item.images?.length || 0,
                        })}
              </span>
              <ChevronDown size={14} />
            </summary>
            {!!item.images?.length && <ImageGallery images={item.images} />}
            {failed && (
              <p className="image-activity-error" role="alert">
                {t("图片操作未完成，请查看详情后重试。")}
              </p>
            )}
            {failed && item.detail && (
              <details className="image-error-details">
                <summary>{t("查看详情")}</summary>
                <pre>{item.detail}</pre>
              </details>
            )}
          </details>
        </div>
      );
    }
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
      {!!item.images?.length && <ImageGallery images={item.images} />}
      {item.sourceTruncated && (
        <div className="source-truncated-note">
          <span>{t("超长内容显示预览，完整内容已保留在原始记录中。")}</span>
          {onSource && (
            <button onClick={onSource}>{t("查看完整原始记录")}</button>
          )}
        </div>
      )}
      <MarkdownText
        text={item.text}
        onOpen={onOpen}
        streaming={["running", "inProgress", "in_progress"].includes(
          item.status || "",
        )}
      />
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
          <CopyButton text={item.text} label={t("复制回答")} iconOnly />
        </div>
      )}
    </article>
  );
}
export const RichMessage = React.memo(RichMessageView, (previous, next) =>
  sameChatItem(previous.item, next.item),
);
