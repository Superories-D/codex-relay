import { expect, it, vi, afterEach } from "vitest";
import { checkEnvironment } from "../src/core/diagnostics";
import { resolveCli } from "../src/core/process";
vi.mock("../src/core/process", () => ({ resolveCli: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it("checks a CLI version with an argument array and no account task", async () => {
  vi.mocked(resolveCli).mockResolvedValue({
    executable: process.execPath,
    prefix: ["-e", 'console.log("codex-cli synthetic-version")', "--"],
  });
  const report = await checkEnvironment("test-only");
  expect(report.checks.find((c) => c.name === "Codex CLI")).toMatchObject({
    status: "ok",
    detail: "codex-cli synthetic-version",
  });
});
it("reports missing executables as a bounded actionable diagnostic", async () => {
  vi.mocked(resolveCli).mockRejectedValue(new Error("ENOENT"));
  const report = await checkEnvironment("missing");
  expect(report.checks.find((c) => c.name === "Codex CLI")).toMatchObject({
    status: "error",
  });
});
it("rejects a selected executable that is not the Codex CLI", async () => {
  vi.mocked(resolveCli).mockResolvedValue({
    executable: process.execPath,
    prefix: [],
  });
  const report = await checkEnvironment("not-codex");
  expect(report.checks.find((c) => c.name === "Codex CLI")?.status).toBe(
    "error",
  );
});
