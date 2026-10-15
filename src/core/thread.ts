import type { Rpc } from "./rpc";
// A brand-new thread may not have a rollout until the first turn. Materialize
// before checkpointing its ID, so pausing during preparation remains resumable.
export async function prepareThread(
  rpc: Rpc,
  threadId: string | undefined,
  config: Record<string, unknown>,
  importedRollout?: string,
) {
  if (threadId) {
    const result = await rpc.call("thread/resume", {
      threadId,
      ...(importedRollout ? { path: importedRollout } : {}),
      ...config,
    });
    if (importedRollout && result.thread?.id !== threadId)
      throw new Error("导入会话恢复后的 ID 不匹配，停止发送任务");
    return result;
  }
  const created = await rpc.call("thread/start", config);
  const id = created.thread.id;
  await rpc.call("thread/archive", { threadId: id });
  await rpc.call("thread/unarchive", { threadId: id });
  return rpc.call("thread/resume", { threadId: id, ...config });
}
