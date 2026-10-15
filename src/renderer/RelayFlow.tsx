import React from "react";
import type { Job } from "../shared/types";
export function RelayFlow({ job }: { job: Job }) {
  const stage = job.stage ?? "";
  const current =
    job.state === "completed"
      ? 5
      : job.state === "waiting" || job.state === "rotating"
        ? 3
        : job.state === "pausing"
          ? 2
          : job.state === "preparing"
            ? job.turnId
              ? 4
              : 0
            : job.state === "running" || job.state === "watching"
              ? stage.includes("复查")
                ? 5
                : 1
              : -1;
  const labels = [
    "准备会话",
    "执行任务",
    "确认停止",
    "轮换 / 等待",
    "接续原会话",
    "完成检查",
  ];
  return (
    <ol className="relay-flow" aria-label="任务接力流程">
      {labels.map((label, i) => (
        <li
          key={label}
          className={current === i ? "current" : ""}
          aria-current={current === i ? "step" : undefined}
        >
          <span>{String(i + 1).padStart(2, "0")}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
