import React, { useEffect, useState } from "react";
import { t, errorText } from "../../renderer/i18n";
import { ActionStatus, useRemoteAction } from "./LiveControls";
import type { ScheduledTask } from "../../core/desktop";
export function RemoteSchedules({
  roots,
  call,
}: {
  roots: string[];
  call: (name: string, args?: any) => Promise<any>;
}) {
  const action = useRemoteAction("schedules", call, "schedules"),
    [tasks, setTasks] = useState<ScheduledTask[]>([]),
    [zone, setZone] = useState(""),
    [error, setError] = useState(""),
    [form, setForm] = useState({
      title: "",
      prompt: "",
      cwd: "",
      cadence: "interval",
      minutes: 60,
      hour: 9,
      minute: 0,
      weekday: 1,
      enabled: true,
      worktree: false,
    }),
    [editing, setEditing] = useState<string>(),
    [remove, setRemove] = useState<string>();
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void call("schedule.list")
        .then((r) => {
          if (alive) {
            setTasks(r.tasks);
            setZone(r.timeZone);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [action.receipt]);
  const input = (task: ScheduledTask) => ({
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    cadence: task.cadence,
    minutes: task.minutes,
    hour: task.hour,
    minute: task.minute,
    weekday: task.weekday,
    enabled: task.enabled,
    worktree: task.worktree,
  });
  return (
    <details className="remote-schedules">
      <summary>
        {t("定时任务")} · {tasks.length}
      </summary>
      <p>
        {t("服务器时区")} · {zone}
      </p>
      <ActionStatus action={action} />
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action.submit(editing ? "schedule.save" : "schedule.create", {
            id: editing || crypto.randomUUID(),
            input: form,
          });
        }}
      >
        <fieldset disabled={!!action.pending}>
          <label>
            {t("名称")}
            <input
              required
              maxLength={120}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            {t("工作目录")}
            <select
              required
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            >
              <option value="">—</option>
              {roots.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            {t("任务描述")}
            <textarea
              required
              maxLength={100000}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </label>
          <label>
            {t("频率")}
            <select
              value={form.cadence}
              onChange={(e) => setForm({ ...form, cadence: e.target.value })}
            >
              <option value="interval">{t("间隔")}</option>
              <option value="daily">{t("每天")}</option>
              <option value="weekly">{t("每周")}</option>
            </select>
          </label>
          {form.cadence === "interval" ? (
            <label>
              {t("分钟")}
              <input
                type="number"
                required
                min={5}
                max={525600}
                value={form.minutes}
                onChange={(e) =>
                  setForm({ ...form, minutes: Number(e.target.value) })
                }
              />
            </label>
          ) : (
            <label>
              {t("时间")}
              <input
                type="time"
                required
                value={`${String(form.hour).padStart(2, "0")}:${String(form.minute).padStart(2, "0")}`}
                onChange={(e) => {
                  const [hour, minute] = e.target.value.split(":").map(Number);
                  setForm({ ...form, hour, minute });
                }}
              />
            </label>
          )}
          {form.cadence === "weekly" && (
            <label>
              {t("星期（0 为周日）")}
              <input
                type="number"
                required
                min={0}
                max={6}
                value={form.weekday}
                onChange={(e) =>
                  setForm({ ...form, weekday: Number(e.target.value) })
                }
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            {t("启用")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.worktree}
              onChange={(e) => setForm({ ...form, worktree: e.target.checked })}
            />
            {t("隔离工作树")}
          </label>
          <button>{editing ? t("保存修改") : t("创建定时任务")}</button>
          {editing && (
            <button type="button" onClick={() => setEditing(undefined)}>
              {t("取消编辑")}
            </button>
          )}
        </fieldset>
      </form>
      {tasks.map((task) => (
        <article key={task.id}>
          <h3>{task.title}</h3>
          <p>
            {task.enabled ? t("启用") : t("已暂停")} · {task.cadence} ·{" "}
            {new Date(task.nextRun).toLocaleString(undefined, {
              timeZone: zone || undefined,
            })}
          </p>
          <p>{task.cwd}</p>
          {task.lastError && <p role="alert">{task.lastError}</p>}
          <fieldset disabled={!!action.pending}>
            <button
              type="button"
              onClick={() => {
                setForm(input(task));
                setEditing(task.id);
              }}
            >
              {t("编辑")}
            </button>
            <button
              type="button"
              onClick={() => action.submit("schedule.run", { id: task.id })}
            >
              {t("立即运行")}
            </button>
            <button
              type="button"
              onClick={() =>
                action.submit("schedule.save", {
                  id: task.id,
                  input: { ...input(task), enabled: !task.enabled },
                })
              }
            >
              {task.enabled ? t("暂停") : t("启用")}
            </button>
            <button type="button" onClick={() => setRemove(task.id)}>
              {t("删除")}
            </button>
            {remove === task.id && (
              <button
                type="button"
                onClick={() => {
                  action.submit("schedule.remove", { id: task.id });
                  setRemove(undefined);
                }}
              >
                {t("确认删除")}
              </button>
            )}
          </fieldset>
        </article>
      ))}
    </details>
  );
}
