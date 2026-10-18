# Concurrent independent conversations

Source implementation following the request to run multiple task threads.
The already delivered 0.6.15 package does not contain this change.

- Settings → General → Concurrent tasks: 1–8, default 3. Lowering the limit
  leaves active tasks running and limits subsequent admission. The task-queue
  icon shows the number of preparing/running/stopping tasks.
- Independent CLI conversations may share one account. Each retains its own
  runtime directory, process, thread, queued messages and lifecycle. Parent and
  adopted-child conversations sharing a runtime home remain mutually exclusive.
  This does not limit native subagents inside an owned CLI process.
- Pause, steer, agent controls and live Goal operations serialize within the
  conversation family, rather than behind an unrelated task's stopping process.
- Approval replies carry both job ID and native request ID. Ambiguous legacy
  replies without a job ID are rejected. Questions retain native acknowledgement.
- Desktop account ownership stays exclusive; unrelated CLI slots can proceed.
  Account refresh remains serialized by the existing central credential manager.
- Shutdown requests all active workers to stop, waits for persistence and retains
  recovery failures. An uncertain process still blocks **new dispatch globally**;
  unrelated workers already running are not automatically interrupted.

## Evidence

- Build and typecheck passed. Full suite: 36 files / 331 tests passed, followed
  by an additional concurrent credential-refresh regression (18 account tests
  passed; resulting suite contains 332 tests).
- Scheduler regressions cover one-account three-task dispatch, changing limits,
  family exclusion, delayed pause vs unrelated steer, duplicate approval IDs,
  single-task quota rotation with original thread, Desktop exclusivity and
  shutdown when one worker fails to close.
- Real local JSONL child processes: two distinct PIDs and threads concurrently
  share a synthetic account; pausing one leaves the other running, and the second
  independently completes with both states persisted. The protocol peer is
  deterministic and does not call a model or use credentials.
- Concurrent refresh regression verifies only one account RPC at a time and
  that each request stages the preceding committed credential, not stale tokens.
- Real Electron settings IPC: default, changing the limit, rejection of invalid
  values, disk persistence, renderer reload and three language labels passed in
  an empty isolated profile. Agent UI regression also passed.
- Local evidence: `qa-output/concurrency-tests.log`,
  `concurrency-native-report.json`, `concurrency-settings-*.png`,
  `agent-ui-report.json`.

No real-account concurrent inference was performed. Provider concurrency limits,
real simultaneous refresh/relay and concurrent task output correctness remain
live acceptance gates. Existing single-task relay evidence is not evidence for
those cases. No installed client, real profile or credential was modified.
