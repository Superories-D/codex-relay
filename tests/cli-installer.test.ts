import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { installManagedCli, MANAGED_CLI_RELEASE } from "../src/core/cli-setup";
import { terminateTree } from "../src/core/process";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("../src/core/process", async (original) => ({
  ...(await original<typeof import("../src/core/process")>()),
  terminateTree: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  status = 200,
  source = "# official installer fixture\n".repeat(10),
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cli-install-"));
  roots.push(root);
  const response = new Response(source, { status });
  Object.defineProperty(response, "url", {
    value: "https://chatgpt.com/codex/install.ps1",
  });
  const fetcher = vi.fn(
    async (_url: string, _options?: RequestInit) => response,
  );
  vi.stubGlobal("fetch", fetcher);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    pid: 100000001,
  });
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      child.exitCode = 0 as any;
      child.emit("close", 0);
    });
    return child as any;
  });
  return { root, child, fetcher };
}

it("downloads only the official installer and executes fixed arguments with an isolated runtime", async () => {
  const f = await fixture();
  const phase = vi.fn();
  const executable = await installManagedCli(
    f.root,
    new AbortController().signal,
    phase,
  );
  expect(f.fetcher.mock.calls[0][0]).toMatch(
    /^https:\/\/chatgpt.com\/codex\/install\.(ps1|sh)$/,
  );
  const [command, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(path.isAbsolute(command)).toBe(true);
  expect(args).toContain(MANAGED_CLI_RELEASE);
  expect(options).toMatchObject({
    shell: false,
    windowsHide: true,
    env: {
      CODEX_NON_INTERACTIVE: "1",
      CODEX_RELEASE: MANAGED_CLI_RELEASE,
      CODEX_HOME: path.join(f.root, "runtime", "managed-cli"),
      CODEX_INSTALL_DIR: path.dirname(executable),
    },
  });
  expect(options!.env!.OPENAI_API_KEY).toBeUndefined();
  expect(options!.env!.CODEX_INSTALL_DAEMON_ONLY).toBeUndefined();
  expect(f.child.stdin.writableEnded).toBe(true);
  expect(phase.mock.calls).toEqual([["downloading"], ["installing"]]);
  expect(await fs.readdir(path.join(f.root, "runtime", "managed-cli"))).toEqual(
    [],
  );
});

it("refuses failed and oversized downloads without executing them and cleans staging", async () => {
  for (const [status, source] of [
    [503, "failure"],
    [200, "x".repeat(2 * 1024 * 1024 + 1)],
  ] as const) {
    const f = await fixture(status, source);
    await expect(
      installManagedCli(f.root, new AbortController().signal, () => {}),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(
      await fs.readdir(path.join(f.root, "runtime", "managed-cli")),
    ).toEqual([]);
  }
});

it("reports nonzero installer exits without leaking synthetic credentials", async () => {
  const f = await fixture();
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      f.child.stderr.write("rt.1.synthetic-secret-refresh-token-1234567890");
      f.child.emit("close", 1);
    });
    return f.child as any;
  });
  await expect(
    installManagedCli(f.root, new AbortController().signal, () => {}),
  ).rejects.not.toThrow("synthetic-secret");
});

it("waits for confirmed process-tree termination when installation is cancelled", async () => {
  const f = await fixture();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(spawn).mockImplementation(() => {
    started();
    return f.child as any;
  });
  vi.mocked(terminateTree).mockImplementation(async () => {
    f.child.exitCode = 1 as any;
    f.child.emit("close", 1);
  });
  const controller = new AbortController();
  const pending = installManagedCli(f.root, controller.signal, () => {});
  await running;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(terminateTree).toHaveBeenCalledExactlyOnceWith(f.child);
});
