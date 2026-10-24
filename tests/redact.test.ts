import { expect, it } from "vitest";
import { redact, redactValue } from "../src/core/redact";

it("masks bare dotted refresh tokens in text and escaped JSON without corrupting boundaries", () => {
  const token = "rt.1." + "Synthetic_0123456789-".repeat(4);
  for (const text of [token, `failure: ${token}. retry`, `first\n${token}\nlast`]) {
    expect(redact(text)).not.toContain(token);
    expect(redact(redact(text))).toBe(redact(text));
  }
  const source = { message: `first\n${token}\tlast`, nested: [token] };
  for (const result of [JSON.parse(redact(JSON.stringify(source))), redactValue(source)]) {
    expect(result.message).toBe("first\n[REDACTED TOKEN]\tlast");
    expect(result.nested).toEqual(["[REDACTED TOKEN]"]);
  }
  expect(redact("rt.1. notes rt.1.short start.1.example"))
    .toBe("rt.1. notes rt.1.short start.1.example");
});

it("removes complete authentication header values, not only their scheme", () => {
  for (const scheme of ["Bearer", "Basic", "token"]) {
    const value = redact(`HTTP 401\nAuthorization: ${scheme} synthetic-opaque-secret\nRetry-After: 10`);
    expect(value).not.toContain("synthetic-opaque-secret");
    expect(value).toContain("Retry-After: 10");
  }
  expect(redact("Proxy-Authorization: Basic synthetic-opaque-secret")).not.toContain("synthetic-opaque-secret");
});

it("keeps structured JSON valid while redacting escaped or quoted secret fields", () => {
  const source = {
    refresh_token: 'synthetic-"quoted\\secret',
    access_token: "synthetic-access",
    id_token: "synthetic-id",
    authorization: "Bearer synthetic-header",
    api_key: "synthetic-key",
    client_secret: "synthetic-client",
    message: "public failure",
    nested: { accessToken: "synthetic-camel" },
  };
  const text = redact(JSON.stringify(source));
  expect(text).not.toContain("synthetic-");
  const result = JSON.parse(text);
  expect(result.message).toBe(source.message);
  for (const key of ["refresh_token", "access_token", "id_token", "authorization", "api_key", "client_secret"])
    expect(result[key]).toBe("[REDACTED]");
  expect(result.nested.accessToken).toBe("[REDACTED]");
});

it("hides HTTP URL user information but retains the destination, paths and ordinary text", () => {
  const value = redact("fatal: https://synthetic-user:synthetic-password@host.invalid:8443/team/repo.git failed\nhttp://synthetic-token@127.0.0.1:8443/api rejected");
  expect(value).not.toContain("synthetic-");
  expect(value).toContain("https://[REDACTED]@host.invalid:8443/team/repo.git");
  expect(value).toContain("http://[REDACTED]@127.0.0.1:8443/api");
  const ordinary = "https://host.invalid/team/repo.git git@host.invalid:team/repo.git C:\\project\\notes.txt user@example.invalid";
  expect(redact(ordinary)).toBe(ordinary);
});

it("preserves JSON containing diagnostic strings and handles single-quoted shell credentials", () => {
  const value = JSON.parse(redact(JSON.stringify({ message: "Authorization: Bearer synthetic-secret\nNetwork disconnected", url: "https://synthetic:secret@host.invalid/repo" })));
  expect(value.message).not.toContain("synthetic-secret");
  expect(value.message).toContain("Network disconnected");
  expect(value.url).toBe("https://[REDACTED]@host.invalid/repo");
  expect(redact("refresh_token='synthetic private value' next=value")).toBe("refresh_token='[REDACTED]' next=value");
  expect(redact("authorization: 'Bearer synthetic-secret'" )).not.toContain("synthetic-secret");
});

it("remains bounded, idempotent, and retains existing JWT and token masking", () => {
  const source = 'eyJsynthetic.payload.signature sk-synthetic123456789 rt-synthetic123456789 {"api_key":"synthetic-secret"}';
  const result = redact(source);
  expect(result).not.toContain("synthetic");
  expect(redact(result)).toBe(result);
  expect(redact(source, 12).length).toBeLessThanOrEqual(12);
  expect(redact(undefined)).toBe("");
});
