import React, { useEffect, useState } from "react";
import { GitBranch, LoaderCircle, Pencil } from "lucide-react";
import type { Job } from "../shared/types";
import { Dialog } from "./Dialog";
import { formatDate, t, useI18n } from "./i18n";

type Turn = {
  id: string;
  status: string;
  startedAt?: number;
  items: {
    type: string;
    text?: string;
    content?: { text?: string; type: string }[];
  }[];
};
function prompt(turn: Turn) {
  return turn.items
    .filter((item) => item.type === "userMessage")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}
export function TurnHistory({
  job,
  call,
  close,
  created,
}: {
  job: Job;
  call: (name: string, args?: unknown) => Promise<any>;
  close: () => void;
  created: (job: Job, text?: string) => Promise<void>;
}) {
  useI18n();
  const [turns, setTurns] = useState<Turn[]>([]),
    [cursor, setCursor] = useState<string>(),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void call("chat.turns", { id: job.id })
      .then((page) => {
        if (alive) {
          setTurns(page.data);
          setCursor(page.nextCursor || undefined);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [job.id]);
  const more = async () => {
    setLoading(true);
    setError("");
    try {
      const page = await call("chat.turns", { id: job.id, cursor });
      setTurns((previous) => {
        const ids = new Set(previous.map((turn) => turn.id));
        return [
          ...previous,
          ...page.data.filter((turn: Turn) => !ids.has(turn.id)),
        ];
      });
      setCursor(page.nextCursor || undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const branch = async (turn: Turn, edit: boolean) => {
    setBusy(true);
    setError("");
    try {
      const fork = await call("chat.branchAt", {
        id: job.id,
        ...(edit ? { beforeTurnId: turn.id } : { lastTurnId: turn.id }),
      });
      await created(fork, edit ? prompt(turn) : undefined);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("会话历史")} busy={busy} onClose={close}>
      <p className="turn-history-description">
        {t(
          "选择一个轮次继续。编辑会创建独立分支，保留原聊天；项目文件保持当前内容。",
        )}
      </p>
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div className="turn-history-list">
        {turns.map((turn) => (
          <section key={turn.id} className="turn-history-entry">
            <header>
              <time>
                {turn.startedAt
                  ? formatDate(turn.startedAt * 1000)
                  : turn.id.slice(0, 8)}
              </time>
              <span>
                {turn.status === "completed"
                  ? t("已完成")
                  : turn.status === "interrupted"
                    ? t("已停止")
                    : turn.status === "failed"
                      ? t("失败")
                      : turn.status}
              </span>
            </header>
            <p>{prompt(turn) || t("工具或审查轮次")}</p>
            <div className="turn-history-actions">
              <button
                disabled={busy || loading || turn.status === "inProgress"}
                onClick={() => void branch(turn, false)}
              >
                <GitBranch size={15} />
                {t("保留本轮创建分支")}
              </button>
              <button
                disabled={
                  busy ||
                  loading ||
                  !prompt(turn) ||
                  turn.status === "inProgress"
                }
                onClick={() => void branch(turn, true)}
              >
                <Pencil size={15} />
                {t("编辑并创建分支")}
              </button>
            </div>
          </section>
        ))}
      </div>
      {loading && (
        <p role="status">
          <LoaderCircle size={16} className="spin" />
          {t("正在读取轮次…")}
        </p>
      )}
      {!loading && !turns.length && !error && (
        <p>{t("此会话尚无可编辑的历史轮次")}</p>
      )}
      {cursor && (
        <button disabled={busy || loading} onClick={() => void more()}>
          {t("加载更早的轮次")}
        </button>
      )}
      {busy && <p role="status">{t("正在创建独立分支，请稍候…")}</p>}
    </Dialog>
  );
}
