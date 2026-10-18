import React, { useEffect, useState } from "react";
import { Check, GitBranch, Plus, RefreshCw } from "lucide-react";
import { t, useI18n, errorText } from "./i18n";
import type { GitBranchList } from "../shared/git";

export function GitBranchPicker({
  cwd,
  call,
  busy,
  close,
  change,
}: {
  cwd: string;
  call: (name: string, args?: unknown) => Promise<any>;
  busy: boolean;
  close: () => void;
  change: (ref: string, head: string, name?: string) => Promise<boolean>;
}) {
  useI18n();
  const [data, setData] = useState<GitBranchList>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void call("workspace.branchList", { cwd })
      .then((value: GitBranchList) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, revision]);
  const selected = data?.branches.find((branch) => branch.ref === ref);
  const creating = create || !!selected?.remote;
  const occupied = !!selected?.worktree && selected.ref !== data?.current;
  const valid =
    !!data &&
    !loading &&
    !busy &&
    (creating
      ? !!name.trim() && (ref === "HEAD" || !!selected)
      : !!selected && !occupied && selected.ref !== data.current);
  return (
    <div
      className="git-branch-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="branch-picker-heading">
        <strong>{t("切换或创建分支")}</strong>
        <button
          title={t("刷新分支列表")}
          disabled={busy || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <input
        autoFocus
        aria-label={t("搜索分支")}
        placeholder={t("搜索分支")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="branch-picker-list"
        role="group"
        aria-label={t("分支列表")}
      >
        <button
          className={ref === "HEAD" && create ? "selected" : ""}
          disabled={busy || loading}
          onClick={() => {
            setRef("HEAD");
            setCreate(true);
          }}
        >
          <Plus size={14} />
          <span>{t("从当前版本创建分支")}</span>
        </button>
        {data?.branches
          .filter((branch) =>
            branch.name.toLowerCase().includes(search.toLowerCase()),
          )
          .map((branch) => (
            <button
              key={branch.ref}
              title={branch.worktree || branch.upstream || branch.name}
              disabled={
                busy ||
                loading ||
                (!!branch.worktree && branch.ref !== data.current && !create)
              }
              className={ref === branch.ref ? "selected" : ""}
              aria-pressed={ref === branch.ref}
              onClick={() => {
                setRef(branch.ref);
                if (branch.remote && !name)
                  setName(branch.name.slice(branch.name.indexOf("/") + 1));
              }}
            >
              {branch.ref === data.current ? (
                <Check size={14} />
              ) : (
                <GitBranch size={14} />
              )}
              <span>{branch.name}</span>
              <small>
                {branch.remote
                  ? t("远程")
                  : branch.worktree && branch.ref !== data.current
                    ? t("其他 Worktree 正在使用")
                    : ""}
              </small>
            </button>
          ))}
      </div>
      <label className="branch-create-toggle">
        <input
          type="checkbox"
          checked={creating}
          disabled={busy || !!selected?.remote}
          onChange={(e) => setCreate(e.target.checked)}
        />
        {t("创建新分支")}
      </label>
      {creating && (
        <input
          aria-label={t("新分支名称")}
          placeholder={t("新分支名称")}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      {selected?.remote && (
        <p className="branch-picker-hint">
          {t("将创建跟踪此远程分支的本地分支。")}
        </p>
      )}
      <div className="branch-picker-actions">
        <button
          disabled={!valid}
          onClick={async () => {
            if (!valid) return;
            const changed = await change(
              ref,
              data!.head,
              creating ? name.trim() : undefined,
            );
            if (changed) close();
            else setRevision((value) => value + 1);
          }}
        >
          {busy ? t("正在切换…") : creating ? t("创建并切换") : t("切换分支")}
        </button>
        <button disabled={busy} onClick={close}>
          {t("取消")}
        </button>
      </div>
    </div>
  );
}
