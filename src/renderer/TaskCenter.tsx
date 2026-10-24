import { WorkflowReport } from "./WorkflowReport";
import { DeliveryCenter } from "./DeliveryCenter";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { dispatchHeld, projectKey, projectLimit } from "../shared/dispatch";
import { dependencyBlockers } from "../shared/task-dependencies";
import { TaskDependencies } from "./TaskDependencies";
import React, { useState } from "react";
import type { Job, Snapshot } from "../shared/types";
import { orderTasks } from "../shared/task-order";
import { t, useI18n, errorText } from "./i18n";
import { RecoveryNotice } from "./RecoveryNotice";
const labels: Record<string, string> = {
  queued: "排队中",
  running: "正在工作",
  preparing: "连接中",
  rotating: "自动切换账户",
  waiting: "等待可用额度",
  pausing: "正在停止",
  paused: "已暂停",
  needs_attention: "需要处理",
  completed: "本轮完成",
  cancelled: "已取消",
  watching: "监控中",
};
const active = (job: Job) =>
  !["completed", "cancelled", "paused"].includes(job.state);
export function TaskCenter({
  snapshot,
  call,
  open,
  close,
}: {
  snapshot: Snapshot;
  call: (name: string, args?: unknown) => Promise<any>;
  open: (job: Job) => void;
  close: () => void;
}) {
  useI18n();
  const [workflowReport, setWorkflowReport] = useState<string>();
  const [deliveryCenter, setDeliveryCenter] = useState(false);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<Job>();
  const [filter, setFilter] = useState("active");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] =
    useState<{ id: string; ok: boolean; error?: string }[]>();
  const [error, setError] = useState("");
  const jobs = snapshot.jobs.filter((j) => !j.archived);
  const filtered = orderTasks(jobs).filter(
    (j) =>
      (!project || (j.projectCwd || j.cwd) === project) &&
      `${j.title} ${j.cwd}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active"
          ? active(j)
          : filter === "recovering"
            ? !!j.autoRecovery
            : filter === "attention"
              ? j.state === "needs_attention" && !j.autoRecovery
              : j.state === filter)),
  );
  const eligible = filtered.filter(
    (j) =>
      !["completed", "cancelled"].includes(j.state) &&
      (!j.existing || j.existing.phase === "managed"),
  );
  const targets = eligible.filter((j) => selected.includes(j.id));
  const projectPaused = snapshot.dispatch?.projects.some(
    (cwd) =>
      projectKey(cwd, snapshot.platform) ===
      projectKey(project, snapshot.platform),
  );
  async function setDispatch(paused: boolean, cwd?: string) {
    setBusy(true);
    setError("");
    try {
      await call("scheduler.dispatch", { paused, ...(cwd ? { cwd } : {}) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function setLimit(limit: number | null) {
    setBusy(true);
    setError("");
    try {
      await call("scheduler.projectLimit", { cwd: project, limit });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const run = async (action: "pause" | "resume") => {
    setBusy(true);
    setError("");
    setReport(undefined);
    try {
      const response = await call("jobs.control", {
        ids: targets.map((j) => j.id),
        action,
      });
      setReport(response.results);
      setSelected(
        response.results
          .filter((r: { ok: boolean }) => !r.ok)
          .map((r: { id: string }) => r.id),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (deliveryCenter) return <DeliveryCenter snapshot={snapshot} call={call} open={open} back={() => setDeliveryCenter(false)}/>;
  return (
    <main className="task-center">
      <header>
        <div>
          <h1>{t("任务中心")}</h1>
          <p>{t("管理运行状态、恢复进度和待执行任务")}</p>
        </div>
        <button className="workflow-trigger" onClick={() => setBuilding(true)}>
          {t("新建工作流")}
        </button>
        <button onClick={() => setDeliveryCenter(true)}>{t("交付中心")}</button>
        <button onClick={close}>{t("返回聊天")}</button>
      </header>
      <section className="dispatch-controls">
        <div>
          <strong>
            {t(snapshot.dispatch?.paused ? "调度已暂停" : "自动调度已开启")}
          </strong>
          <p>
            {t(
              "暂停调度只阻止新任务启动，当前任务会继续完成。设置在重启后保留。",
            )}
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => void setDispatch(!snapshot.dispatch?.paused)}
        >
          {t(snapshot.dispatch?.paused ? "开启全局调度" : "暂停全局调度")}
        </button>
      </section>
      <div className="task-summary">
        {[
          ["active", "进行中", jobs.filter(active).length],
          ["recovering", "自动恢复", jobs.filter((j) => j.autoRecovery).length],
          [
            "attention",
            "需要处理",
            jobs.filter((j) => j.state === "needs_attention" && !j.autoRecovery)
              .length,
          ],
          ["paused", "已暂停", jobs.filter((j) => j.state === "paused").length],
          ["all", "全部任务", jobs.length],
        ].map(([value, label, count]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(String(value))}
          >
            <strong>{count}</strong>
            {t(String(label))}
          </button>
        ))}
      </div>
      <div className="task-filters">
        <input
          aria-label={t("搜索任务")}
          placeholder={t("搜索任务")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={t("筛选项目")}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">{t("全部项目")}</option>
          {[
            ...new Set([
              ...jobs.map((j) => j.projectCwd || j.cwd),
              ...(snapshot.dispatch?.projects || []),
              ...(snapshot.projectLimits || []).map((p) => p.cwd),
            ]),
          ].map((cwd) => (
            <option key={cwd} value={cwd}>
              {cwd}
            </option>
          ))}
        </select>
      </div>
      {project && (
        <button
          className="project-dispatch"
          disabled={busy}
          onClick={() => void setDispatch(!projectPaused, project)}
        >
          {t(projectPaused ? "开启此项目调度" : "暂停此项目调度")}
        </button>
      )}
      {project && (
        <label className="project-limit">
          {t("项目并发上限")}
          <select
            disabled={busy}
            value={
              projectLimit(snapshot, { cwd: project }, snapshot.platform) || ""
            }
            onChange={(e) =>
              void setLimit(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">{t("跟随全局上限")}</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <small>
            {t("降低上限不会中断正在运行的任务；名额释放后自动继续排队任务。")}
          </small>
        </label>
      )}
      <div className="queue-actions">
        <button
          disabled={busy || !eligible.length}
          onClick={() => setSelected(eligible.slice(0, 100).map((j) => j.id))}
        >
          {t("选择当前列表")}
        </button>
        <button
          disabled={busy || !targets.length}
          onClick={() => void run("pause")}
        >
          {t("暂停所选")} ({targets.length})
        </button>
        <button
          disabled={
            busy ||
            !targets.length ||
            targets.some(
              (j) =>
                !["paused", "needs_attention"].includes(j.state) ||
                j.autoRecovery,
            )
          }
          onClick={() => void run("resume")}
        >
          {t("恢复所选")}
        </button>
        <button
          disabled={busy || !selected.length}
          onClick={() => setSelected([])}
        >
          {t("清除选择")}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div role="status" className="task-report">
          <p>
            {t("已完成 {ok} 项，失败 {failed} 项", {
              ok: report.filter((r) => r.ok).length,
              failed: report.filter((r) => !r.ok).length,
            })}
          </p>
          {report
            .filter((r) => !r.ok)
            .map((r) => (
              <p key={r.id}>
                {jobs.find((j) => j.id === r.id)?.title || r.id}:{" "}
                {errorText(r.error)}
              </p>
            ))}
        </div>
      )}
      {workflowReport && (
        <WorkflowReport
          id={workflowReport}
          call={call}
          close={() => setWorkflowReport(undefined)}
        />
      )}
      {building && (
        <WorkflowBuilder
          jobs={snapshot.jobs}
          cwd={project}
          call={call}
          close={() => setBuilding(false)}
        />
      )}
      {editing && (
        <TaskDependencies
          job={snapshot.jobs.find((j) => j.id === editing.id) || editing}
          jobs={snapshot.jobs}
          call={call}
          close={() => setEditing(undefined)}
        />
      )}
      <div className="task-list">
        {filtered.map((job) => (
          <article key={job.id}>
            <div className="task-card-title">
              <input
                type="checkbox"
                aria-label={job.title}
                disabled={busy || !eligible.includes(job)}
                checked={selected.includes(job.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked
                      ? [...ids, job.id].slice(-100)
                      : ids.filter((id) => id !== job.id),
                  )
                }
              />
              <button onClick={() => open(job)}>{job.title}</button>
              <small>
                {job.autoRecovery ? t("正在自动恢复") : t(labels[job.state])}
              </small>
            </div>
            {job.workflow && (
              <div className="workflow-label">
                {job.workflow.title} · {job.workflow.step}/{job.workflow.total}{" "}
                <button
                  className="workflow-report-trigger"
                  onClick={() => setWorkflowReport(job.workflow!.id)}
                >
                  {t("工作流交付报告")}
                </button>
              </div>
            )}
            <p className="task-cwd">{job.projectCwd || job.cwd}</p>
            <small>
              {t("待发送队列")} · {job.queuedMessages?.length || 0} ·{" "}
              {t(
                job.priority === "high"
                  ? "优先执行"
                  : job.priority === "low"
                    ? "空闲时执行"
                    : "普通优先级",
              )}
            </small>
            {dispatchHeld(snapshot, job, snapshot.platform) &&
              ["queued", "waiting"].includes(job.state) && (
                <p>{t("调度已暂停")}</p>
              )}
            {!!job.dependsOn?.length && (
              <p className="task-dependencies">
                {t("前置任务")} ·{" "}
                {job.dependsOn
                  .map(
                    (id) =>
                      snapshot.jobs.find((j) => j.id === id)?.title ||
                      t("已删除的任务"),
                  )
                  .join(" → ")}{" "}
                ·{" "}
                {t("等待 {count} 项完成", {
                  count: dependencyBlockers(job, snapshot.jobs).length,
                })}
              </p>
            )}
            {["queued", "waiting", "paused"].includes(job.state) && (
              <button
                className="dependencies-trigger"
                onClick={() => setEditing(job)}
              >
                {t("设置前置任务")}
              </button>
            )}
            {job.autoRecovery && <RecoveryNotice job={job} />}
            {job.lastError && !job.autoRecovery && (
              <p className="task-error">{job.lastError}</p>
            )}
          </article>
        ))}
      </div>
      {!filtered.length && <p>{t("没有符合条件的任务")}</p>}
    </main>
  );
}
