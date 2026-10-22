export function redact(value: unknown, limit = 16000): string {
  return String(value ?? "")
    .replace(/\b(https?:\/\/)[^/\s"'<>?#]*@/gi, "$1[REDACTED]@")
    .replace(
      /((?:["']?)(?:access_?token|refresh_?token|id_?token|(?:proxy-)?authorization|api_?key|client_?secret)["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic|Token)[ \t]+[^\s,;}"'\\]+|[^\s,;}"'\\]+)/gi,
      (_match, key: string, secret: string) => {
        const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
        // Some callers parse redacted JSON to display safe diagnostic objects.
        // Keep quoted values quoted, including originally escaped contents.
        return `${key}${quote}[REDACTED]${quote}`;
      },
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED JWT]",
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-|rt-)[A-Za-z0-9_-]{12,}/g, "[REDACTED TOKEN]")
    .slice(0, limit);
}
