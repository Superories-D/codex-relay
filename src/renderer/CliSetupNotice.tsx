import React, { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { CliSetupState } from "../shared/cli-setup";
import { errorText, t, useI18n } from "./i18n";
import "./cli-setup.css";

export function CliSetupNotice({
  call,
}: {
  call: (name: string, args?: unknown) => Promise<any>;
}) {
  useI18n();
  const [state, setState] = useState<CliSetupState>();
  const [retrying, setRetrying] = useState(false);
  const caller = useRef(call);
  caller.current = call;
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await caller.current("cli.status");
        if (alive && value?.phase) setState(value);
      } catch {
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(read, 750);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!state || state.phase === "ready") return null;
  const failed = state.phase === "error";
  return (
    <aside className="cli-setup-notice" role={failed ? "alert" : "status"}>
      {failed ? (
        <TriangleAlert size={18} />
      ) : state.phase === "downloading" ? (
        <Download size={18} />
      ) : (
        <LoaderCircle size={18} className="spin" />
      )}
      <div>
        <strong>
          {failed ? t("Codex CLI 尚未就绪") : t("正在准备 Codex CLI")}
        </strong>
        <p>
          {state.phase === "checking"
            ? t("正在检查已有安装…")
            : state.phase === "downloading"
              ? t("未找到可用 CLI，正在下载官方安装器…")
              : state.phase === "installing"
                ? t("正在自动安装，完成后即可开始任务。")
                : state.phase === "verifying"
                  ? t("正在验证 CLI 安装…")
                  : t("安装未完成。请检查网络后重试，或在设置中指定已有 CLI。")}
        </p>
        {failed && state.error && (
          <details>
            <summary>{t("查看详细错误")}</summary>
            <pre>{state.error}</pre>
          </details>
        )}
      </div>
      {failed && (
        <button
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              const value = await call("cli.ensure");
              if (value?.phase) setState(value);
            } catch (error) {
              setState({ phase: "error", error: errorText(error) });
            } finally {
              setRetrying(false);
            }
          }}
        >
          <RefreshCw size={14} />
          {t("重新检测并安装")}
        </button>
      )}
    </aside>
  );
}
