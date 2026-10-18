# Scheduled task admission and recovery — 2026-10-18

Source milestone after the delivered v0.6.16 packages. Those packages have not
been rebuilt or replaced; the changes below are not in the user's installed app.

## Behavior

- A schedule serializes edits, deletion and admission. Overlapping manual/timer
  triggers share one pending admission. Independent schedules do not share that
  lock; admitted jobs use the existing concurrent scheduler.
- Persist an occurrence reservation before creating a worktree or job. The job
  stores the same schedule/occurrence identity. On restart, reconcile an already
  admitted job rather than submit it again, including when the schedule is paused.
  An interrupted reservation without a job can resume when the schedule is enabled.
- Git worktrees use the occurrence ID. A retry reuses the registered worktree;
  an existing, unregistered directory is refused rather than overwritten.
- An unfinished, paused, attention-required or recovery-required previous run
  blocks new admissions. Resume or cancel the previous run first. Missed intervals
  collapse into one occurrence; manual execution does not postpone a future due
  time. Known admission failures retry at the next due time or on a manual request.
- Shutdown drains in-progress preparation before stopping the scheduler. A
  worktree still being prepared cannot admit a new job after closing begins.
- The weekly template uses explicit cadence metadata, fixing its incorrect daily
  cadence in Japanese and English. Weekdays and schedule errors are localized.
  The schedule page refreshes while open to show timer activity.

## Evidence

- `npm run build`: passed.
- `npm test -- --maxWorkers=4`: 37 files, 343 tests passed, including ten new
  schedule cases. Tests cover competing triggers, future cadence, unfinished
  runs, stale edits/deletion, persisted identity after a bookkeeping write failure
  with fresh Desktop/Store/Scheduler instances, reservation recovery, write failure
  before admission, real Git worktree reuse, and shutdown during preparation.
- `scripts/qa/schedules-native.cjs`: passed in actual development Electron with
  an isolated empty-account profile. Verified automatic overdue startup admission,
  rejection while a run remains unfinished, cancellation then simultaneous manual
  admission, unchanged future due time, Japanese weekly-template creation, save,
  pause, renderer reload, and UI deletion preserving task history. No renderer
  errors. Screenshot visually checked.
- Native QA initially used an async predicate with Playwright `waitForFunction`;
  the local implementation treated its Promise as truthy, causing an early
  assertion and shutdown during initial navigation. The script now awaits UI
  readiness and polls IPC results explicitly. Nested-label selectors were also
  corrected. The final pass above uses those corrected checks.

Ignored local evidence: `qa-output/schedules-native-report.json`,
`qa-output/schedules-native-ja.png`, and isolated `schedules-native-*` profiles.
No account credentials were loaded and no inference requests were sent.

## Remaining acceptance

This verifies persistence, scheduling admission and UI lifecycle, not actual
scheduled model execution or output correctness. Real-account scheduled work,
concurrent relay/refresh, sleep/wake and clock/time-zone changes still require
bounded acceptance. Tasks require the machine and client to remain running;
there is no OS background wake service. Packaging these changes is a separate
delivery step. The broader release-readiness goal remains active.
