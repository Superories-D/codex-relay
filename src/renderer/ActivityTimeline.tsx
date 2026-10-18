import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  FilePenLine,
  LoaderCircle,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { ChatItem } from "../shared/types";
import { RichMessage } from "./RichMessage";
import { t, useI18n } from "./i18n";
import { activityRuns } from "./chat-view";
import { usePresence } from "./MotionRegion";
import { MediaContext } from "./ChatImages";

type Props = Omit<React.ComponentProps<typeof RichMessage>, "item">;
function ActivityGroup({ items, ...props }: Props & { items: ChatItem[] }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const present = usePresence(expanded);
  const executing = items.some(
    (item) => item.status === "running" || item.status === "inProgress",
  );
  const failed = items.filter(
    (item) => item.status === "failed" || item.status === "declined",
  ).length;
  const edited = items.some((item) => ["fileChange", "diff"].includes(item.kind));
  const commands = items.some((item) => item.kind === "commandExecution");
  return (
    <details
      className={`activity-group ${executing ? "is-running" : ""} ${failed ? "has-failures" : ""}`}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary>
        {executing ? (
          <LoaderCircle size={16} className="spin" />
        ) : edited ? (
          <FilePenLine size={16} />
        ) : commands ? (
          <SquareTerminal size={16} />
        ) : (
          <Wrench size={16} />
        )}
        <span>
          {edited && commands
            ? t("编辑了文件并运行了命令")
            : edited
              ? t("编辑了文件")
              : commands
                ? t("运行了命令")
                : t("工具活动")}
        </span>
        <small>{t("{p0} 项操作", { p0: items.length })}</small>
        {executing && <small className="activity-running">{t("进行中")}</small>}
        {!!failed && (
          <small className="activity-failed" role="status">
            {t("{p0} 项失败", { p0: failed })}
          </small>
        )}
        <ChevronDown size={14} className="disclosure-chevron" />
      </summary>
      <div className="activity-group-scroll">
        {present &&
          items.map((item) => (
            <RichMessage key={item.id} item={item} {...props} />
          ))}
      </div>
    </details>
  );
}

export function ActivityTimeline({
  items,
  scope,
  jobId,
  ...props
}: Props & { items: ChatItem[]; scope: string; jobId?: string }) {
  const mediaContext = useMemo(
    () => ({ id: jobId || scope, ...(jobId ? { threadId: scope } : {}) }),
    [jobId, scope],
  );
  return (
    <MediaContext.Provider value={mediaContext}>
      {activityRuns(
        items.filter((item) => item.kind !== "questionRequest"),
      ).map((run) =>
        run.group ? (
          <ActivityGroup
            key={`${scope}:${run.items[0].id}`}
            items={run.items}
            {...props}
          />
        ) : (
          <RichMessage
            key={`${scope}:${run.items[0].id}`}
            item={run.items[0]}
            {...props}
          />
        ),
      )}
    </MediaContext.Provider>
  );
}
