import { EventEmitter } from "node:events";
import type { Approval, Job, Quota } from "../shared/types";
export interface Outcome {
  kind:
    | "completed"
    | "quota"
    | "interrupted"
    | "recoverable"
    | "error"
    | "incomplete"
    | "goalStopped"
    | "modelUnavailable"
    | "modelRoute";
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
  inspect?(): Promise<unknown>;
  show?(): Promise<void>;
  steer?(
    text: string,
    attachments: import("../shared/types").ChatAttachment[],
  ): Promise<void>;
  operation?(method: string, params: Record<string, unknown>): Promise<unknown>;
  agentControl?(
    threadId: string,
    action: "send" | "interrupt",
    text?: string,
  ): Promise<unknown>;
}
export interface WorkerContext {
  job: Job;
  home: string;
  cli: string;
  resumePrompt: string;
  // A native automatic turn can start before pending user input is accepted.
  // Pass false to retain that input while recording the active turn.
  checkpoint(
    threadId: string,
    turnId?: string,
    submitted?: boolean,
  ): Promise<void>;
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
          : method === "item/permissions/requestApproval"
            ? "permissions"
            : method === "mcpServer/elicitation/request"
              ? "elicitation"
              : "unsupported";
  return { jobId, id, method, params, kind };
}
