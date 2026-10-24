# Windows operations cockpit — 0.6.26

The task center now opens an actionable operations view: current admission
blockers, pending reviews, durable observations and actual delivery provenance.
Selecting a task does not resume it or answer a request.

## Current admission and review

The scheduler supplies the explanation using its actual account selection,
runtime ownership, control queues, recovery barriers, global/project limits,
dispatch state, CLI readiness and warmup state. Related prerequisite tasks are
directly navigable. Account reasons include ownership, authentication, model
access and quota availability. Reason counts can overlap.

Admission is an observation, not a reservation or evidence that a process has
started. A task's own unfinished artifact acceptance is a review concern;
unaccepted prerequisite outputs block dependent admission. Existing global
ownership recovery can still block unrelated projects; the cockpit exposes that
behavior rather than claiming isolation it does not implement.

Every newly admitted approval receives a fresh review identity. The cockpit
freezes the request being reviewed, disables an obsolete form and rechecks the
live worker and exact identity before submitting. This protects against a
protocol request ID being reused. Existing input-history guards remain in place.
Older clients can omit the optional identity; the new cockpit always sends it.

Current artifact acceptance, stored manifest/report revisions, workflow reports
and Telegram known/unknown receipts link to their existing detailed interfaces.
A saved manifest reference does not imply a fresh rehash of all stored bytes.
Task completion, artifact acceptance, stored-file integrity and notification
delivery remain separate facts.

## Durable observations

A dedicated SQLite worker records explicit allowed fields before renderer
snapshot coalescing. The log preserves state, runtime/control ownership,
requests, recovery evidence, acceptance revisions and user stop intent. Runtime
ownership does not certify that an OS process spawned. Startup creates an
observed baseline with a possible downtime gap, not invented past transitions.

History supports all-task, task and family scopes. Keyset pagination freezes an
upper sequence ceiling, so concurrent appends do not shift older/newer pages.
Sequence values remain exact beyond JavaScript's safe integer limit. Each page
holds at most 100 events (the interface requests 40); old database history is
not silently trimmed. The UI retains cursor positions rather than every page's
event bodies. Task lists use search, filters and 30-row pages.

Worker writes use atomic transactions, WAL and full synchronous durability.
The interface shows acknowledged sequence/time, pending writes and failures.
An exhausted 16 MiB pending-write allowance or storage failure visibly pauses
recording while task control continues. Explicit re-enable records a new
baseline and a gap rather than replaying an uncertain queue. Corrupt, unrelated
or future-schema databases are preserved and fail closed. Observations cannot
prove events that occurred while recording was unavailable.
An unexpectedly terminated worker releases its connection reference and pending
requests; explicit retry starts a new worker instead of awaiting a dead thread.

The allowed projection excludes prompts, raw request parameters/answers,
credentials, account emails and absolute source/runtime paths. Project keys are
hashed and runtime family IDs are opaque. User-entered task/project titles may
still contain private information; the log is local product data, not anonymous.

Windows atomic state replacement now retries transient file locks after checking
the original temporary file's identity. It never falls back to truncating the
destination or replacing an unrecognized temporary file.

## Validation and limits

- Full current-source Windows suite: **664 passed, 43 platform skips, 90 files**;
  TypeScript and production build pass.
- Actual Electron/scheduler/SQLite/vault test: simultaneous blockers, exact saved
  provenance, workflow navigation, stable pagination under appends, a real SQLite
  transaction failure and UI retry, restart baseline and retained pause intent.
- Native Simplified Chinese, Traditional Chinese, English and Japanese layouts
  pass; English is checked at 150% zoom with no untranslated Chinese copy.
- Production renderer with synthetic IPC: stale request replacement, fresh exact
  decision identity, secret-input draft confinement and zoom. Backend identity
  enforcement is separately covered using the actual scheduler and mock worker.
- A 100,000-event SQLite fixture retains all history: observed reopen 270 ms,
  first 40-event query 7 ms, 100,003 task events after new observations. These are
  local measurements, not a performance guarantee for every machine.
- Exact large sequence cursors, rollback, overload gaps, corrupt-database
  preservation, actual worker termination/retry, rapid transitions and
  optional-field clearing have focused tests.

All checks use isolated profiles without new model inference or external Bot
messages. Packaged Windows acceptance passed: operations native flows, two CLI
startups, vault crash recovery, local Telegram emulation, delivery center,
portable startup and Setup wizard (no Install click). Ten ASAR code/style
bundles match the build; all 88 files in the complete ZIP match unpacked bytes.
Packaging and Gitea
readback evidence is retained separately under ignored QA output. The installed
application hosting this work is not upgraded by these checks. Linux-specific
development remains paused; Windows packages are unsigned.

## Research and design inferences

Official [scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app)
and [worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees)
support reviewable runs and explicit execution context. The official
[remote engineering example](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
describes tracking active, blocked, review-ready and finished work. The cockpit's
explicit blockers and durable observations are our design inference from those
workflows; this is not proof of parity with or superiority over the official app.
The [Node worker documentation](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
informed the separate worker boundary; actual packaged behavior is tested.
