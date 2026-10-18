import { beforeAll, afterAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
const execute = promisify(execFile);
let root: string, bundle: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-schedule-clock-"));
  bundle = path.join(root, "desktop.cjs");
  await build({
    stdin: { contents: 'export { Desktop, nextSchedule } from "./src/core/desktop"; export { Schedules } from "./src/core/schedules";', resolveDir: process.cwd() },
    outfile: bundle, bundle: true, platform: "node", format: "cjs",
  });
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

type Case = [string, "daily" | "weekly" | "interval", number, number, number, string];
async function check(zone: string, cases: Case[]) {
  const { stdout } = await execute(process.execPath, ["-e", `
    const { nextSchedule } = require(process.argv[1]);
    const cases = JSON.parse(process.argv[2]);
    console.log(JSON.stringify(cases.map(([now, cadence, hour, minute, weekday]) =>
      new Date(nextSchedule({ cadence, hour, minute, weekday, minutes: 60 }, Date.parse(now))).toISOString())));
  `, bundle, JSON.stringify(cases)], { env: { ...process.env, TZ: zone }, windowsHide: true, timeout: 10000 });
  expect(JSON.parse(stdout)).toEqual(cases.map((row) => row[5]));
}
it("keeps requested calendar hours after a spring gap and chooses only one fall-fold occurrence", async () => {
  await check("America/New_York", [
    ["2026-03-07T12:00:00-05:00", "daily", 2, 30, 1, "2026-03-08T07:30:00.000Z"],
    ["2026-03-08T03:30:00-04:00", "daily", 2, 30, 1, "2026-03-09T06:30:00.000Z"],
    ["2026-03-08T12:00:00-04:00", "weekly", 2, 30, 1, "2026-03-09T06:30:00.000Z"],
    ["2026-03-08T03:30:00-04:00", "weekly", 2, 30, 0, "2026-03-15T06:30:00.000Z"],
    ["2026-11-01T00:30:00-04:00", "daily", 1, 30, 0, "2026-11-01T05:30:00.000Z"],
    ["2026-11-01T01:30:00-04:00", "daily", 1, 30, 0, "2026-11-02T06:30:00.000Z"],
    ["2026-11-01T01:15:00-05:00", "daily", 1, 30, 0, "2026-11-02T06:30:00.000Z"],
    ["2026-11-01T01:30:00-04:00", "interval", 1, 30, 0, "2026-11-01T06:30:00.000Z"],
  ]);
});
it("handles a half-hour DST gap without carrying it to the next day", async () => {
  await check("Australia/Lord_Howe", [
    ["2026-10-03T12:00:00+10:30", "daily", 2, 15, 0, "2026-10-03T15:45:00.000Z"],
    ["2026-10-04T02:45:00+11:00", "daily", 2, 15, 0, "2026-10-04T15:15:00.000Z"],
  ]);
});
it("preserves Japanese local cadence, month/year boundaries and exact-due behavior", async () => {
  await check("Asia/Tokyo", [
    ["2026-10-18T09:29:59+09:00", "daily", 9, 30, 1, "2026-10-18T00:30:00.000Z"],
    ["2026-10-18T09:30:00+09:00", "daily", 9, 30, 1, "2026-10-19T00:30:00.000Z"],
    ["2026-12-31T12:00:00+09:00", "daily", 9, 30, 1, "2027-01-01T00:30:00.000Z"],
    ["2026-10-18T12:00:00+09:00", "weekly", 9, 30, 1, "2026-10-19T00:30:00.000Z"],
  ]);
});

it("reprojects durable local-calendar schedules through real process time-zone changes and restart", async () => {
  const profile = await fs.mkdtemp(path.join(root, "zone-"));
  const { stdout } = await execute(process.execPath, ["-e", `
    const { Desktop, Schedules } = require(process.argv[1]);
    (async () => {
      const now = Date.parse("2026-10-18T00:00:00Z"), desktop = new Desktop(process.argv[2]);
      const scheduler = { store: { data: { jobs: [] } }, log: (error) => { throw error; } };
      const schedules = new Schedules(desktop, scheduler, () => {}, () => now);
      const input = { title: "Zone fixture", prompt: "No model", cwd: process.argv[2], enabled: false,
        cadence: "daily", minutes: 60, hour: 9, minute: 30, weekday: 1, worktree: false };
      await schedules.save(input);
      const task = desktop.data.schedules[0], results = [new Date(task.nextRun).toISOString()];
      await schedules.save({ ...input, cadence: "interval" });
      const intervalDue = desktop.data.schedules[1].nextRun;
      process.env.TZ = "Asia/Tokyo";
      await schedules.tick();
      results.push(new Date(task.nextRun).toISOString(), task.nextRunZone, desktop.data.schedules[1].nextRun === intervalDue);
      await schedules.shutdown();
      const restored = new Desktop(process.argv[2]);
      await restored.load();
      process.env.TZ = "Asia/Shanghai";
      const recovered = new Schedules(restored, scheduler, () => {}, () => now);
      await recovered.tick();
      results.push(new Date(restored.data.schedules[0].nextRun).toISOString(), restored.data.schedules[0].nextRunZone);
      await recovered.shutdown();
      console.log(JSON.stringify(results));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, bundle, profile], { env: { ...process.env, TZ: "America/New_York" }, windowsHide: true, timeout: 10000 });
  expect(JSON.parse(stdout)).toEqual([
    "2026-10-18T13:30:00.000Z", "2026-10-18T00:30:00.000Z", "Asia/Tokyo", true,
    "2026-10-18T01:30:00.000Z", "Asia/Shanghai",
  ]);
});
