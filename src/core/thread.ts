import type { Rpc } from "./rpc";
// A brand-new thread may not have a rollout until the first turn. Materialize
// before checkpointing its ID, so pausing during preparation remains resumable.
export async function prepareThread(
  rpc: Rpc,
  threadId: string | undefined,
  config: Record<string, unknown>,
) {
  if (threadId) return rpc.call("thread/resume", { threadId, ...config });
  const created = await rpc.call("thread/start", config);
  const id = created.thread.id;
  await rpc.call("thread/archive", { threadId: id });
  await rpc.call("thread/unarchive", { threadId: id });
  return rpc.call("thread/resume", { threadId: id, ...config });
}
