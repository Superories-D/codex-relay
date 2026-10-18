import { t, useI18n, errorText } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, SquareTerminal, X, ChevronDown } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession as Session } from "../shared/types";
// A hidden/reopened pane shares an in-flight initial start instead of spawning
// another shell while the first pane is awaiting IPC.
let initialStart: Promise<Session> | undefined;
export function TerminalPane({
  cwd,
  close,
  call,
}: {
  cwd: string;
  close: () => void;
  call: (name: string, args?: unknown) => Promise<any>;
}) {
  useI18n();

  const [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<string[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const openingRef = useRef(false);
  const closingRef = useRef(new Set<string>());
  const revision = useRef(0);
  const callRef = useRef(call);
  callRef.current = call;
  const add = async (initial = false) => {
    if (openingRef.current || !cwd) return;
    openingRef.current = true;
    revision.current++;
    setOpening(true);
    setError("");
    try {
      if (initial && !initialStart) {
        initialStart = callRef.current("terminal.open", { cwd }).finally(() => {
          initialStart = undefined;
        });
      }
      const s = await (initial
        ? initialStart!
        : callRef.current("terminal.open", { cwd }));
      if (alive.current) {
        setSessions((v) => [...v.filter((item) => item.id !== s.id), s]);
        setSelected(s.id);
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      openingRef.current = false;
      revision.current++;
      if (alive.current) setOpening(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false,
      loading = false,
      initialized = false;
    const refresh = async () => {
      if (loading || openingRef.current || closingRef.current.size) return;
      loading = true;
      const current = revision.current;
      try {
        const value: Session[] = await callRef.current("terminal.list");
        if (disposed || current !== revision.current) return;
        setSessions((old) =>
          JSON.stringify(old) === JSON.stringify(value) ? old : value,
        );
        if (!initialized) {
          initialized = true;
          if (value.length)
            setSelected(
              (value.filter((s) => s.cwd === cwd).at(-1) || value.at(-1))!.id,
            );
          else if (cwd) void add(true);
        }
      } catch (e) {
        if (!disposed) setError(errorText(e));
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!sessions.some((s) => s.id === selected))
      setSelected(sessions.at(-1)?.id || "");
  }, [sessions, selected]);
  const remove = async (id: string) => {
    if (closingRef.current.has(id)) return;
    closingRef.current.add(id);
    setClosing([...closingRef.current]);
    revision.current++;
    try {
      await callRef.current("terminal.close", { id });
      if (alive.current) {
        setSessions((value) => value.filter((s) => s.id !== id));
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      closingRef.current.delete(id);
      revision.current++;
      if (alive.current) setClosing([...closingRef.current]);
    }
  };
  useEffect(() => {
    if (!selected || !host.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: "#181818",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#454545",
      },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    let stopped = false,
      loading = false,
      cursor = 0;
    const read = async () => {
      if (loading || stopped) return;
      loading = true;
      try {
        const result = await callRef.current("terminal.read", {
          id: selected,
          cursor,
        });
        if (!stopped) {
          if (result.reset) terminal.reset();
          terminal.write(result.text);
          cursor = result.cursor;
          const wasDisabled = terminal.options.disableStdin;
          terminal.options.disableStdin = result.state !== "running";
          if (wasDisabled && result.state === "running") {
            void callRef
              .current("terminal.resize", {
                id: selected,
                cols: terminal.cols,
                rows: terminal.rows,
              })
              .catch(() => {});
          }
          setSessions((value) =>
            value.map((s) =>
              s.id === selected &&
              (s.state !== result.state ||
                s.exitCode !== result.exitCode ||
                s.error !== result.error)
                ? {
                    ...s,
                    state: result.state,
                    exitCode: result.exitCode,
                    error: result.error,
                  }
                : s,
            ),
          );
        }
      } catch (e) {
        if (!stopped && !closingRef.current.has(selected))
          setError(errorText(e));
      } finally {
        loading = false;
      }
    };
    const input = terminal.onData((text) => {
      void callRef
        .current("terminal.write", { id: selected, text })
        .catch((e) => {
          if (!stopped) setError(errorText(e));
        });
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void callRef
        .current("terminal.resize", {
          id: selected,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => {});
    });
    resize.observe(host.current);
    void read();
    const timer = setInterval(read, 150);
    terminal.focus();
    return () => {
      stopped = true;
      clearInterval(timer);
      resize.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [selected]);
  const current = sessions.find((s) => s.id === selected);
  const status = (s: Session) =>
    s.state === "starting"
      ? t("终端正在启动")
      : s.state === "closing"
        ? t("终端正在关闭")
        : s.state === "exited"
          ? t("终端已退出（代码 {code}）", { code: s.exitCode ?? "—" })
          : s.state === "error"
            ? errorText(s.error || t("终端连接已关闭"))
            : "";
  return (
    <section className="terminal-pane" aria-label={t("集成终端")}>
      <header>
        <span className="terminal-label">
          <SquareTerminal size={15} />
          {t("终端")}
        </span>
        <div className="terminal-tabs">
          {sessions.map((s, index) => (
            <div key={s.id} className={s.id === selected ? "selected" : ""}>
              <button
                title={[s.cwd, status(s)].filter(Boolean).join(" · ")}
                onClick={() => {
                  setSelected(s.id);
                  setError("");
                }}
              >
                {s.name} {index + 1}
                {s.state !== "running" && (
                  <span className="terminal-state-dot" data-state={s.state} />
                )}
              </button>
              <button
                aria-label={t("关闭终端 {p0}", { p0: index + 1 })}
                disabled={closing.includes(s.id)}
                onClick={() => void remove(s.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          title={t("新建终端")}
          aria-label={t("新建终端")}
          disabled={opening || !cwd || sessions.length >= 8}
          onClick={() => void add()}
        >
          <Plus size={16} />
        </button>
        <button
          title={t("隐藏终端")}
          aria-label={t("隐藏终端")}
          onClick={close}
        >
          <ChevronDown size={16} />
        </button>
      </header>
      {current && (
        <div className="terminal-session-info" role="status">
          <span title={current.cwd}>{current.cwd}</span>
          <span>{status(current)}</span>
        </div>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div className="terminal-host" ref={host} />
      {!selected && (
        <button
          className="terminal-empty"
          disabled={opening || !cwd}
          onClick={() => void add()}
        >
          {opening ? t("正在连接 PowerShell…") : t("新建终端")}
        </button>
      )}
    </section>
  );
}
