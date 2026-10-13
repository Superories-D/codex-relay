import { EventEmitter } from "node:events";
import type { Approval, Job, Quota } from "../shared/types";
export interface Outcome {
  kind: "completed" | "quota" | "interrupted" | "error";
  error?: unknown;
}
export interface Worker extends EventEmitter {
  done: Promise<Outcome>;
  start(auth: {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string;
  }): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  quota(): Promise<Record<string, Quota>>;
  respond(id: string, value: unknown): void;
}
export interface WorkerContext {
  job: Job;
  home: string;
  cli: string;
  resumePrompt: string;
  checkpoint(threadId: string, turnId?: string): Promise<void>;
  shouldStart(): boolean;
  refresh(): Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string;
  }>;
}
export type WorkerFactory = (ctx: WorkerContext) => Worker;
export function approvalFrom(
  jobId: string,
  id: string,
  method: string,
  params: unknown,
): Approval {
  const kind =
    method === "item/commandExecution/requestApproval"
      ? "command"
      : method === "item/fileChange/requestApproval"
        ? "file"
        : method === "item/tool/requestUserInput"
          ? "input"
          : "unsupported";
  return { jobId, id, method, params, kind };
}
