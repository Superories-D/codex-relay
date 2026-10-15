import React, { useState } from "react";
import { Dialog } from "./Dialog";
import type {
  ExistingCandidate,
  ExistingInspection,
  Job,
} from "../shared/types";
const labels = {
  running: "运行中",
  quota: "额度中断",
  completed: "本轮已结束",
  interrupted: "已中断",
  unknown: "待核实",
};
export function ExistingDialog({
  command,
  close,
  attached,
}: {
  command: (name: string, args?: unknown) => Promise<unknown>;
  close: () => void;
  attached: (job: Job) => void;
}) {
  const [home, setHome] = useState("");
  const [threadId, setThreadId] = useState("");
  const [rows, setRows] = useState<ExistingCandidate[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [inspection, setInspection] = useState<ExistingInspection>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [scanned, setScanned] = useState(false);
  const [mode, setMode] = useState<"cli" | "desktop">("cli"),
    [strategy, setStrategy] = useState<"quota" | "now">("quota");
  const [allowStop, setAllowStop] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="接入已有 Codex 会话" busy={busy} onClose={close}>
      <p className="eyebrow">CONTINUE EXISTING WORK</p>
      <h2>让正在做的任务接着跑</h2>
      <p>
        选择已打开的终端或官方客户端会话。监控期间保留原窗口；交接时结束下方列出的
        Codex 实例，再用原会话 ID 和工作目录接续。
      </p>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <label>
        原 Codex 数据目录（留空自动查找）
        <div className="row gap session-home">
          <input
            value={home}
            onChange={(e) => {
              setHome(e.target.value);
              setInspection(undefined);
              setRows([]);
              setScanned(false);
            }}
            placeholder="例如 C:\Users\你\.codex"
            disabled={busy}
          />
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const p = await command("choose.directory");
                if (typeof p === "string") {
                  setHome(p);
                  setInspection(undefined);
                  setRows([]);
                  setScanned(false);
                }
              })
            }
          >
            选择目录
          </button>
        </div>
      </label>
      <details>
        <summary>按会话 ID 查找较早的会话</summary>
        <label>
          会话 ID
          <input
            value={threadId}
            onChange={(e) => {
              setThreadId(e.target.value);
              setInspection(undefined);
              setRows([]);
              setScanned(false);
            }}
            disabled={busy}
          />
        </label>
      </details>
      <button
        className="full"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setInspection(undefined);
            setAllowStop(false);
            const result = (await command("session.scan", {
              ...(home.trim() ? { home: home.trim() } : {}),
              ...(threadId.trim() ? { threadId: threadId.trim() } : {}),
            })) as {
              home: string;
              candidates: ExistingCandidate[];
              warnings: string[];
            };
            setHome(result.home);
            setRows(result.candidates);
            setWarnings(result.warnings);
            setScanned(true);
          })
        }
      >
        {busy ? "正在检查…" : "扫描本机会话"}
      </button>
      {warnings.map((w) => (
        <p className="notice" key={w}>
          {w}
        </p>
      ))}
      {scanned && (
        <>
          <label>
            筛选会话
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="任务内容、工作目录或会话 ID"
            />
          </label>
          <div className="session-list" aria-label="本机会话列表">
            {rows
              .filter((r) =>
                `${r.title} ${r.cwd} ${r.threadId}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((row) => (
                <button
                  type="button"
                  key={row.id}
                  disabled={busy || !!row.issue}
                  className={`session-row ${inspection?.candidate.id === row.id ? "selected" : ""}`}
                  onClick={() =>
                    void run(async () => {
                      setAllowStop(false);
                      setInspection(undefined);
                      setInspection(
                        (await command(
                          "session.inspect",
                          row.id,
                        )) as ExistingInspection,
                      );
                    })
                  }
                >
                  <b>{row.title}</b>
                  <span>
                    {labels[row.status]} · {row.source} ·{" "}
                    {new Date(row.updatedAt).toLocaleString("zh-CN")}
                  </span>
                  <small>{row.cwd}</small>
                  {row.issue && (
                    <small className="danger-text">{row.issue}</small>
                  )}
                </button>
              ))}
            {!rows.length && (
              <p>
                未发现可读取的本机会话。可选择自定义
                CODEX_HOME；WSL、远程和仅云端会话暂不能迁入 Windows。
              </p>
            )}
          </div>
        </>
      )}
      {inspection && (
        <div className="session-inspection">
          <h3>交接范围</h3>
          <p className="session-id">{inspection.candidate.threadId}</p>
          {inspection.issue && <p className="alert">{inspection.issue}</p>}
          {inspection.processes.map((p) => (
            <div className="process-card" key={`${p.pid}:${p.startedAt}`}>
              <b>
                PID {p.pid} · {p.title || "Codex 终端进程"}
              </b>
              <small>{p.executable}</small>
            </div>
          ))}
          {!inspection.processes.length && inspection.canHandoff && (
            <p>未发现仍在运行的 Codex 实例，可以恢复保存的会话。</p>
          )}
          <div className="form-grid">
            <label>
              何时交接
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as any)}
                disabled={busy}
              >
                <option value="quota">额度中断时自动交接</option>
                <option value="now">立即交接并继续</option>
              </select>
            </label>
            <label>
              交接后的运行方式
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as any)}
                disabled={busy}
              >
                <option value="cli">Codex CLI</option>
                <option value="desktop">官方客户端（实验适配）</option>
              </select>
            </label>
          </div>
          {inspection.processes.length > 0 && (
            <label className="session-consent">
              <input
                type="checkbox"
                checked={allowStop}
                disabled={busy}
                onChange={(e) => setAllowStop(e.target.checked)}
              />
              <span>
                允许交接时结束上述 Codex
                实例及其子进程。同一桌面实例的其他会话也会停止；终端窗口本身保留。立即交接可能中断正在执行的命令。
              </span>
            </label>
          )}
          <p className="subtle">
            接续前会检查已完成的操作；原会话文件保留。交接后请在 Relay
            中操作，不要同时从原客户端恢复同一任务。关闭 Relay
            只暂停监控，不会结束尚未交接的原窗口。
          </p>
          <button
            className="primary full"
            disabled={
              busy ||
              !inspection.canHandoff ||
              (inspection.processes.length > 0 && !allowStop)
            }
            onClick={() =>
              void run(async () => {
                attached(
                  (await command("session.attach", {
                    id: inspection.candidate.id,
                    strategy,
                    mode,
                    allowStop,
                  })) as Job,
                );
              })
            }
          >
            {busy
              ? "正在接入…"
              : strategy === "quota"
                ? "接入并等待额度中断"
                : "接入并立即交接"}
          </button>
        </div>
      )}
    </Dialog>
  );
}
