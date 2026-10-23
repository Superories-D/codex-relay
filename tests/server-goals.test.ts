import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ServerRuntime } from "../src/server/runtime";
import { TelegramConsole } from "../src/server/telegram-console";
it.skipIf(process.platform !== "linux")(
  "shares strict goal validation, paused creation and durable operation receipts across server and bot",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-goals-")),
      runtime = await ServerRuntime.open(root);
    try {
      await runtime.scheduler.dispatch(true);
      const job: any = await runtime.command("job.add", {
        title: "goals",
        prompt: "test",
        cwd: root,
        mode: "cli",
        model: "",
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
      });
      const native = vi
        .spyOn(runtime.scheduler, "goal")
        .mockResolvedValue({ goal: null } as any);
      const bot = new TelegramConsole(
        runtime,
        [root],
        (s) => s,
        async () => {},
        Date.now,
      );
      const id = randomUUID();
      await bot.execute(
        "goal",
        "create 20000 Improve quality",
        { task: job.id },
        id,
      );
      expect(native).toHaveBeenCalledWith(
        job.id,
        "thread/goal/set",
        { objective: "Improve quality", tokenBudget: 20000, status: "paused" },
        "create",
      );
      await bot.execute(
        "goal",
        "create 20000 Improve quality",
        { task: job.id },
        id,
      );
      expect(native).toHaveBeenCalledTimes(1);
      for (const input of [
        { id: job.id, action: "budget", tokenBudget: -1 },
        { id: job.id, action: "start", tokenBudget: null },
        { id: job.id, action: "edit", objective: "x".repeat(4001) },
      ])
        await expect(
          runtime.command("goal.update", { requestId: randomUUID(), input }),
        ).rejects.toThrow();
      expect(native).toHaveBeenCalledTimes(1);
      await bot.execute("goal", "start", { task: job.id }, randomUUID());
      expect(native).toHaveBeenLastCalledWith(
        job.id,
        "thread/goal/set",
        { status: "active" },
        "start",
      );
      await bot.execute("goal", "budget none", { task: job.id }, randomUUID());
      expect(native).toHaveBeenLastCalledWith(job.id, "thread/goal/set", {
        tokenBudget: null,
      });
      native.mockRejectedValueOnce(Error("connection lost"));
      const uncertain: any = await runtime.command("goal.update", {
        requestId: randomUUID(),
        input: { id: job.id, action: "clear" },
      });
      expect(uncertain.state).toBe("uncertain");
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
