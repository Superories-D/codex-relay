# Automatic interruption recovery — 2026-10-22

Source changes after v0.6.17. No new release, installed-client restart, credential
change, or quota-consuming model run is part of this change.

## Behavior

- CLI interruptions that were not requested by the user, unknown terminal status,
  missing final quota/result evidence, lost connections, and missing native Goal
  admission events enter automatic recovery instead of requiring Continue.
- Recovery retains the thread, task, pending messages, attachments, Goal accounting
  and completion requirements. Only normal completion drains the next queued message.
- Retries back off through 2, 4, 8, 16, 32 and 60 seconds, then remain at 60 seconds.
  Timing and retry counts survive restarts. A healthy account cannot skip the delay.
  Successful completion or explicit user resumption resets the interruption count.
- Startup automatically checks interrupted managed tasks, including older persisted
  `recoveryRequired` records. It does not automatically adopt an unmanaged window.
- Pause/Cancel intent is saved immediately, even while a slow ownership check is
  pending, and before process stopping. Recovery can finish cleanup
  but cannot restart inference after that intent. Old `pausing` records are treated
  as a pause. Archived chats are not resumed.
- Goal reads distinguish transient failures, malformed replies and explicit absence;
  unknown state triggers recovery without losing pending input or admission flags.
  Explicitly unsupported Goal APIs still allow ordinary chat. Newer Goal events
  outrank older read responses, and known quota exhaustion retains priority.
- Missing/invalid turn acknowledgements retain the uncertain-input marker and
  trigger recovery instead of leaving the conversation running indefinitely.
- Every resumed thread is checked against its expected ID, including ordinary
  managed threads and newly materialized threads; mismatches stop submission.
- The conversation and task manager show recovery progress and expandable details.
  The conversation has a Pause recovery control. Automatic recovery does not produce
  a misleading “needs your attention” desktop notification. Chinese, Traditional
  Chinese, English and Japanese use the existing localization system.

## Ownership, persistence and uncertain input

The scheduler serializes recovery with controls for the same runtime directory.
It awaits the old run and confirms worker shutdown, then invokes the same recovery
checks used by manual controls. A live/malformed ownership record or unverified
Desktop receipt keeps the queue gated. No arbitrary PID is killed and no live lock
is removed. The gate is released only after the recovered state has been saved;
failed saves restore the gate and schedule another check.

Before `turn/start`, `review/start` or initial Goal `turn/steer`, the worker saves an
uncertain-submission marker. Only an acknowledgement clears it. If the response is
lost, a replacement worker uses the same thread and an inspection/continuation
instruction containing the pending request, instead of replaying the request
verbatim. An uncertain review resumes as an inspection turn rather than repeating
`review/start`. This reduces duplicate work; it is **not an exactly-once guarantee**
for external side effects. The model still has to inspect existing results.

Active Goals resume through native admission without a synthetic user turn unless
there is pending/uncertain user input. Paused, blocked, budget-limited and completed
Goals are not reactivated by the recovery loop. Approvals and user questions are
not automatically answered. Configuration errors and invalid account credentials
retain their existing handling. Recovery does not infer that silence during a long
model/tool operation is a crash.

## Validation

- Unit and scheduler coverage: exponential backoff, same-thread continuation,
  input preservation, pause/cancel across restart and failed cleanup, live owner
  rejection, durable-save gating, configuration failures and unanswered approvals.
- Real local JSONL subprocess fixtures: unknown status, unexpected interruption,
  connection exit and accepted input with a lost acknowledgement. In each case the
  original process is gone before a second process starts; both use the same thread,
  the normal scheduler loop recovers without `job.control`, and completion clears
  recovery state. These are deterministic local protocol peers, not real inference.
- `scripts/qa/recovery-ui.cjs`: production renderer, synthetic IPC, Chinese dark
  1440px, English light 900px and Japanese dark 900px; localized countdown updates,
  expanding details, width bounds, Pause IPC and zero renderer exceptions.
- Final `npm run check`: build/typecheck passed; **50 test files, 460 passed,
  2 Windows-only PowerShell tests skipped** on this Linux host.
  Windows process-tree recovery and provider-dependent behavior still require
  native acceptance. Existing v0.6.17 binaries do not include these changes.

Reproduce with `npm ci`, `npm run check`, then
`RELAY_CHROMIUM_PATH=/path/to/chromium node scripts/qa/recovery-ui.cjs` with
Playwright installed. A headless host without CJK fonts can provide a WOFF2 font
using `RELAY_QA_FONT`. Screenshots and the UI report are written to ignored
`qa-output/`.
