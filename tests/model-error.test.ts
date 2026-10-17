import { expect, it } from "vitest";
import { isModelRejection } from "../src/core/model-error";
const message =
  "The 'wanted' model is not supported when using Codex with a ChatGPT account.";
it("recognizes the verified native invalid-request envelope and exact model only", () => {
  const error = {
    message: JSON.stringify({
      type: "error",
      status: 400,
      error: { type: "invalid_request_error", message },
    }),
    codexErrorInfo: "other",
  };
  expect(isModelRejection(error, "wanted")).toBe(true);
  expect(isModelRejection({ detail: error }, "wanted")).toBe(true);
  expect(isModelRejection({ message }, "wanted")).toBe(true);
  expect(isModelRejection(error, "another")).toBe(false);
  expect(isModelRejection(error, "")).toBe(false);
});
it("does not guess from generic errors, permission errors, catalog introductions or quoted tool output", () => {
  for (const error of [
    null,
    message,
    { message: "403 forbidden" },
    { message: "Model not available" },
    { message: `Tool says: ${message}` },
    { availabilityNux: { message } },
    {
      message: JSON.stringify({
        status: 503,
        error: { type: "invalid_request_error", message },
      }),
    },
  ])
    expect(isModelRejection(error, "wanted")).toBe(false);
});
