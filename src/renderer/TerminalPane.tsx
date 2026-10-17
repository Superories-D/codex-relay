import { t, useI18n } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, SquareTerminal, X, ChevronDown } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
type Session = { id: string; cwd: string; name: string; state: string };
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
  const host = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const add = async () => {
    setOpening(true);
    setError("");
    try {
      const s = await call("terminal.open", { cwd });
      if (alive.current) {
        setSessions((v) => [...v, s]);
        setSelected(s.id);
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setOpening(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void call("terminal.list").then((value: Session[]) => {
      if (!alive.current) return;
      setSessions(value);
      if (value.length) setSelected(value.at(-1)!.id);
      else if (cwd) void add();
    });
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!selected || !host.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
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
        const result = await call("terminal.read", { id: selected, cursor });
        if (!stopped) {
          if (result.reset) terminal.reset();
          terminal.write(result.text);
          cursor = result.cursor;
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      } finally {
        loading = false;
      }
    };
    const input = terminal.onData((text) => {
      void call("terminal.write", { id: selected, text }).catch((e) =>
        setError(String(e)),
      );
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void call("terminal.resize", {
        id: selected,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {});
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
              <button onClick={() => setSelected(s.id)}>
                {s.name} {index + 1}
              </button>
              <button
                aria-label={t("关闭终端 {p0}", { p0: index + 1 })}
                onClick={async () => {
                  try {
                    await call("terminal.close", { id: s.id });
                    const next = sessions.filter((v) => v.id !== s.id);
                    setSessions(next);
                    if (selected === s.id) setSelected(next.at(-1)?.id || "");
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          title={t("新建终端")}
          aria-label={t("新建终端")}
          disabled={opening || !cwd}
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
