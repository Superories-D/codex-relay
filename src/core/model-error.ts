// Only inspect actual RPC/turn errors, never assistant text or tool output.
// This exact rejection was verified against the authenticated native CLI.
export function isModelRejection(error: unknown, model?: string): boolean {
  if (!model || !error || typeof error !== "object") return false;
  const detail = (error as any).detail ?? error;
  let message = detail.message ?? detail.error?.message;
  if (typeof message !== "string") return false;
  try {
    const envelope = JSON.parse(message);
    if (
      envelope.status !== 400 ||
      envelope.error?.type !== "invalid_request_error"
    )
      return false;
    message = envelope.error.message;
  } catch {
    /* A plain RPC error may already contain the inner message. */
  }
  return (
    message ===
    `The '${model}' model is not supported when using Codex with a ChatGPT account.`
  );
}
