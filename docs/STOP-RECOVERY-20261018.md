# Missing interruption acknowledgement and safe relay — 2026-10-18

The user's screenshot showed `需要处理`, a usage-limited Goal and
`无法确认原进程停止，禁止启动第二个任务进程`. A read-only snapshot obtained
through the documented Explorer Desktop Shell helper subsequently showed the
same thread running with an active Goal and four recorded rotations. Available
logs included the workspace-credit exhaustion message, but did not retain enough
information to identify the exact cleanup failure behind the earlier screenshot.
No installed profile, credentials or active process was modified during diagnosis.

Code inspection found a reproducible related defect: a missing `turn/completed`
after `turn/interrupt` was reported as a failed process stop. Scheduler cleanup
could then successfully close the process, while the earlier failure flag still
froze dispatch. Thus missing protocol confirmation and failed process cleanup
were treated as the same condition.

The CLI worker now retains the owner and awaits `Rpc.close()` after an interrupt
error or its 20-second terminal-event deadline. That existing close path must
confirm managed process termination and remove the matching ownership record.
Only then does the worker settle as quota-interrupted or user-interrupted, retaining
the original thread and existing Goal recovery authority. It never reports task
completion from this fallback. Late terminal notifications cannot settle the
worker while process-stop confirmation is still pending.

If cleanup fails, `ProcessSafetyError` and the global recovery gate still prevent
new dispatch. Missing events alone no longer create a false process-recovery
requirement. The scheduler now records cleanup failures from its final close
path, which previously replaced the outcome without logging the underlying reason.

## Evidence and limits

- Build passed; final full suite passed 366 tests across 40 files.
- Worker tests cover delayed cleanup, late terminal events during cleanup,
  failed cleanup, quota preservation, same thread and active Goal recovery.
- Scheduler test verifies failed cleanup remains persisted across restart and
  its underlying reason is logged.
- Real local JSONL subprocess integration reproduces a peer that acknowledges
  interruption but omits its terminal event. It verifies the old process is gone
  before the second account's process is admitted, both use the same persisted
  thread, and the task completes. This uses a deterministic local protocol peer,
  synthetic accounts and no network/model inference, not a real-account claim.
- Actual CLI/Electron PTY process termination is separately verified by
  `TERMINALS-20261018.md`. The exact installed-client interruption and deep
  subagent/cross-account combinations still need independent acceptance.

Source after v0.6.16; no new package, installation or automatic restart performed.
