import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ServerRuntime } from "../src/server/runtime";
import { TelegramConsole } from "../src/server/telegram-console";
it.skipIf(process.platform !== "linux")(
  "persists remote schedules, deduplicates manual runs, prevents overlap and revalidates automatic workspace admission",
  async () => {
    const base = await fs.mkdtemp(
        path.join(os.tmpdir(), "relay-remote-schedule-"),
      ),
      work = path.join(base, "project"),
      root = path.join(base, "data");
    await fs.mkdir(work);
    let runtime = await ServerRuntime.open(root, undefined, [work]);
    try {
      await runtime.scheduler.dispatch(true);
      const id = randomUUID(),
        input = {
          title: "nightly",
          prompt: "check",
          cwd: work,
          enabled: true,
          cadence: "interval",
          minutes: 60,
          hour: 9,
          minute: 0,
          weekday: 1,
          worktree: false,
        },
        request = { requestId: randomUUID(), id, input };
      const created = await runtime.command("schedule.create", request);
      expect(await runtime.command("schedule.create", request)).toEqual(
        created,
      );
      expect(runtime.desktop.data.schedules).toHaveLength(1);
      const run = { requestId: randomUUID(), id };
      const first: any = await runtime.command("schedule.run", run);
      expect(first.state).toBe("succeeded");
      expect(runtime.store.data.jobs).toHaveLength(1);
      expect(await runtime.command("schedule.run", run)).toEqual(first);
      const overlap: any = await runtime.command("schedule.run", {
        ...run,
        requestId: randomUUID(),
      });
      expect(overlap.state).toBe("uncertain");
      expect(runtime.store.data.jobs).toHaveLength(1);
      const bot = new TelegramConsole(
        runtime,
        [work],
        (s) => s,
        async () => {},
        Date.now,
      );
      await bot.execute("schedule", `pause ${id}`, {}, randomUUID());
      expect(runtime.desktop.data.schedules[0].enabled).toBe(false);
      await expect(
        runtime.command("schedule.create", {
          requestId: randomUUID(),
          id: randomUUID(),
          input: { ...input, cwd: root },
        }),
      ).rejects.toThrow("outside");
      runtime.desktop.data.schedules[0].enabled = true;
      runtime.desktop.data.schedules[0].nextRun = Date.now() - 1000;
      runtime.store.data.jobs[0].state = "completed";
      await runtime.desktop.save();
      await runtime.store.save();
      await runtime.close();
      runtime = await ServerRuntime.open(root);
      await runtime.schedules.tick();
      expect(runtime.store.data.jobs).toHaveLength(1);
      expect(runtime.desktop.data.schedules[0].lastError).toContain("outside");
      await runtime.close();
      runtime = await ServerRuntime.open(root, undefined, [work]);
      runtime.desktop.data.schedules[0].nextRun = Date.now() - 1000;
      await runtime.schedules.tick();
      expect(runtime.store.data.jobs).toHaveLength(2);
      expect(
        ((await runtime.command("schedule.list")) as any).timeZone,
      ).toBeTruthy();
    } finally {
      await runtime.close();
      await fs.rm(base, { recursive: true, force: true });
    }
  },
);
