import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { RemoteActions } from "../src/server/actions";
import { atomicWrite } from "../src/core/store";
it("records intent before effects, deduplicates concurrency and refuses conflict/replay after crash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-actions-"));
  try {
    const actions = new RemoteActions(root),
      id = randomUUID(),
      job = randomUUID();
    let calls = 0;
    const effect = async () => {
      calls++;
      expect((await actions.read(id))?.state).toBe("pending");
      return { applied: true };
    };
    const results = await Promise.all([
      actions.run(id, "steer", job, { text: "one" }, effect),
      actions.run(id, "steer", job, { text: "one" }, effect),
    ]);
    expect(calls).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(
      (
        await new RemoteActions(root).run(
          id,
          "steer",
          job,
          { text: "one" },
          effect,
        )
      ).state,
    ).toBe("succeeded");
    await expect(
      actions.run(id, "steer", job, { text: "other" }, effect),
    ).rejects.toThrow("different");
    let writes = 0;
    const crash = new RemoteActions(root, async (file, text) => {
      if (++writes === 2) throw Error("disk lost");
      await atomicWrite(file, text);
    });
    const crashId = randomUUID();
    await expect(
      crash.run(crashId, "steer", job, {}, async () => {
        calls++;
      }),
    ).rejects.toThrow("disk lost");
    expect(
      (await new RemoteActions(root).run(crashId, "steer", job, {}, effect))
        .state,
    ).toBe("pending");
    expect(calls).toBe(2);
    const fail = new RemoteActions(root, async () => {
      throw Error("disk full");
    });
    await expect(
      fail.run(randomUUID(), "steer", job, {}, effect),
    ).rejects.toThrow("disk full");
    expect(calls).toBe(2);
    const uncertain = await actions.run(
      randomUUID(),
      "steer",
      job,
      {},
      async () => {
        throw Error("api_key: secret lost");
      },
    );
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.error).not.toContain("secret");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "linux")(
  "recovers model-blocked jobs once and reports stale model changes",
  async () => {
    const { ServerRuntime } = await import("../src/server/runtime");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-"));
    const runtime = await ServerRuntime.open(root);
    try {
      await runtime.scheduler.dispatch(true);
      const job: any = await runtime.command("job.add", {
        title: "model",
        prompt: "test",
        cwd: root,
        mode: "cli",
        model: "blocked",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      job.state = "waiting";
      job.waitingFor = "model";
      await runtime.store.save();
      const args = {
        requestId: randomUUID(),
        id: job.id,
        model: "available",
        effort: "high",
      };
      const first: any = await runtime.command("task.model", args);
      expect(first.result).toEqual({ applied: true });
      expect(job.state).toBe("queued");
      expect(job.model).toBe("available");
      expect(await runtime.command("task.model", args)).toEqual(first);
      const stale: any = await runtime.command("task.model", {
        ...args,
        requestId: randomUUID(),
        model: "other",
      });
      expect(stale.result).toEqual({ applied: false });
      expect(job.model).toBe("available");
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
