import { expect, it, vi } from "vitest";
import { CliSetup, MANAGED_CLI_RELEASE } from "../src/core/cli-setup";
import { ProcessSafetyError } from "../src/core/process-safety-error";

const version = `codex-cli ${MANAGED_CLI_RELEASE}`;
function fixture() {
  let configured = "codex";
  const probe = vi.fn<(cli: string) => Promise<string>>(async () => {
    throw Error("ENOENT");
  });
  const install = vi.fn(
    async (
      _root: string,
      _signal: AbortSignal,
      phase: (value: "installing") => void,
    ) => {
      phase("installing");
      return "/managed/codex";
    },
  );
  const changed = vi.fn();
  const select = vi.fn(async (cli: string, previous: string) => {
    expect(configured).toBe(previous);
    configured = cli;
  });
  const setup = new CliSetup(
    { root: "/relay", configured: () => configured, select, changed },
    { probe, install, candidates: () => ["/known/codex"] },
  );
  return {
    setup,
    probe,
    install,
    select,
    changed,
    configured: () => configured,
  };
}

it("reuses a working configured CLI without installation or settings writes", async () => {
  const f = fixture();
  f.probe.mockResolvedValue(version);
  expect(await f.setup.ensure()).toEqual({
    phase: "ready",
    path: "codex",
    version,
  });
  expect(f.install).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
});

it("finds existing installations outside PATH and persists their usable path", async () => {
  const f = fixture();
  f.probe.mockImplementation(async (cli) => {
    if (cli === "/known/codex") return version;
    throw Error("ENOENT");
  });
  expect((await f.setup.ensure()).path).toBe("/known/codex");
  expect(f.configured()).toBe("/known/codex");
  expect(f.install).not.toHaveBeenCalled();
});

it("shares a single missing-CLI install, verifies the result and avoids reinstall on next check", async () => {
  const f = fixture();
  f.probe.mockImplementation(async (cli) => {
    if (cli === "/managed/codex") return version;
    throw Error("ENOENT");
  });
  const first = f.setup.ensure(),
    second = f.setup.ensure();
  expect(first).toBe(second);
  expect((await first).phase).toBe("ready");
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.select).toHaveBeenCalledExactlyOnceWith("/managed/codex", "codex");
  expect(f.changed.mock.calls.map(([state]) => state.phase)).toEqual([
    "checking",
    "installing",
    "verifying",
    "ready",
  ]);
  await f.setup.ensure();
  expect(f.install).toHaveBeenCalledTimes(1);
});

it("does not save a broken installation and permits a later retry", async () => {
  const f = fixture();
  expect((await f.setup.ensure()).phase).toBe("error");
  expect(f.select).not.toHaveBeenCalled();
  f.probe.mockImplementation(async (cli) => {
    if (cli === "/managed/codex") return version;
    throw Error("ENOENT");
  });
  expect((await f.setup.ensure()).phase).toBe("ready");
  expect(f.install).toHaveBeenCalledTimes(2);
});

it("requires version verification and successful durable path selection before publishing ready", async () => {
  const f = fixture();
  f.probe.mockImplementation(async (cli) => {
    if (cli === "/managed/codex") return "codex-cli 0.1.0";
    throw Error("ENOENT");
  });
  expect((await f.setup.ensure()).phase).toBe("error");
  expect(f.select).not.toHaveBeenCalled();
  f.probe.mockImplementation(async (cli) => {
    if (cli === "/managed/codex") return version;
    throw Error("ENOENT");
  });
  f.select.mockRejectedValue(Error("disk write failed"));
  expect(await f.setup.ensure()).toMatchObject({
    phase: "error",
    error: "disk write failed",
  });
  expect(f.configured()).toBe("codex");
});

it("aborts installation on shutdown and never publishes or saves it as usable", async () => {
  const f = fixture();
  let started!: () => void;
  const installing = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.install.mockImplementation(async (_root, signal) => {
    started();
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      }),
    );
    return "/managed/codex";
  });
  const pending = f.setup.ensure();
  await installing;
  await f.setup.shutdown();
  expect((await pending).phase).toBe("error");
  expect(f.select).not.toHaveBeenCalled();
  await f.setup.ensure();
  expect(f.install).toHaveBeenCalledTimes(1);
});

it("retains a failed process-stop gate and refuses to report safe shutdown", async () => {
  const f = fixture();
  f.install.mockRejectedValue(
    new ProcessSafetyError("process remains live", Error("kill failed")),
  );
  await f.setup.ensure();
  await expect(f.setup.shutdown()).rejects.toThrow("process remains live");
});
