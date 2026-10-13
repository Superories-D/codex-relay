export function redact(value: unknown): string {
  return String(value ?? "")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED JWT]",
    )
    .replace(/\b(sk-|rt-)[A-Za-z0-9_-]{12,}/g, "[REDACTED TOKEN]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|authorization|api_key)"?\s*[:=]\s*)("[^"\n]*"|[^\s,}]+)/gi,
      "$1[REDACTED]",
    )
    .slice(0, 16000);
}
