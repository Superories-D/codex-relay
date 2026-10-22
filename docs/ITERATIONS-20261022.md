# Twenty sequential iterations — 2026-10-22

Each iteration is validated and pushed before the next begins. These are source changes; no new binaries or native installation.

## 1. Connection lifecycle recovery

Initialization exits, output EOF, pipe errors and RPC timeouts now propagate typed recoverable failures, including events before a worker subscribes. Pending RPCs settle immediately; invalid executable/configuration errors retain their identity. Targeted transport/worker tests and build pass.

## 2. Persistent recovery history

Chats now retain the latest 50 recovery events, including retry, reconnection, stop and completion. Expandable localized history survives restart; details are redacted and bounded. Recovery-save rollback also restores its history. Build, scheduler/history/redaction/localization tests and Chinese/English/Japanese renderer checks passed.

## 3. Editable pending-message queue

Stable message IDs and queue revisions support editing, removing and reordering pending inputs. Stale views are rejected. Queue writes are durable before normal completion may drain them; failed writes restore the original queue. Pending text enters the transcript only when admitted. Build and 78 scheduler/storage/localization tests passed; three-language renderer checks exercise reorder/edit/remove.

## 4. Resilient composer drafts

Text and attachment references share a versioned local draft record, with migration from the old text-only format. New-chat drafts are isolated by project. Debounced writes flush on pagehide/window close; failed saves surface a warning. Successful sends clear only their own content, preserving newer input. Build and 10 draft/localization tests passed; three-language reload checks restore text and attachment-only drafts.

## 5. Full conversation search

Search persisted and live messages beyond the current history page, including tool details, literal code fragments and Unicode-width variants. Role filters, bounded excerpts, pagination and original-message inspection/copy are available from the conversation menu. Latest journal revisions win; stale results are ignored by the renderer. Build and 15 history/localization tests passed; three-language UI checks search and inspect a result.

## 6. Priority-aware task admission

High/normal/low priorities are editable from the conversation header and persist across restart. Eligible work is ordered by priority then enqueue/creation time; explicit resumes and new inputs acquire a fresh enqueue time. Running work is never preempted and process/account/recovery gates remain authoritative. Failed priority writes roll back. Build and 71 scheduler/localization tests passed; three-language UI checks change priority.

## 7. Task control center

A dedicated task center replaces the advanced queue navigation: status summaries, project/text filters, visible-task selection, priority context and recovery cards. Bulk pause/resume returns per-task success/failure, deduplicates IDs and refuses unsafe unmanaged adoption or completed-task resumption. Build and 73 scheduler/localization tests passed; three-language UI checks exercise selection, bulk pause and paused-state filtering. Actual layout screenshots were inspected.

## 8. Reusable task templates

Save/edit/delete named instructions with model, reasoning and planning preferences. Inserting a template appends to the draft and never starts work. A separate versioned store serializes mutations, rejects stale revisions and publishes only after atomic writes; corrupt storage is preserved. Build and 9 template/localization tests passed; three-language renderer checks save and insert a template without sending inference requests.

## 9. Task diagnostic reports

A previewable JSON report explains known blockers and includes a whitelisted task/environment summary, bounded recovery history and recent diagnostic logs. It excludes account credential objects, prompt fields and output logs, and redacts diagnostic strings. Users can copy/export it locally or run `relay.cjs report --id JOB_ID`. Build and 11 report/IPC/localization tests passed; three-language UI checks preview and request export. Native save dialogs remain an OS acceptance boundary.

## 10. Resilient CLI monitoring

CLI watch reconnects with bounded exponential backoff, reloads the local IPC credential on each attempt and only resubscribes to snapshots. Acknowledged run/attach operations switch to read-only monitoring; unacknowledged creation is never replayed. Recovery attention states remain observable until recovery finishes. `status --json` and `watch --json` expose a compact task projection without account credentials or prompt fields; `--no-reconnect` preserves fail-fast behavior. Real CLI subprocess fixtures verify token rotation, resubscription and no duplicate creation.

The user extended this sequence to 15 iterations while iteration 10 was in progress. Native Windows process-tree/dialog/installation and real-account inference acceptance remain separate from this Linux test environment.

Round 10 verification: full `npm run check` passed (53 files, 490 passed, 2 Windows-only skipped); production-renderer QA passed Chinese/English/Japanese with zero renderer errors. Native Windows dialogs/process acceptance remains outside this Linux fixture.

## 11 — Persistent task prerequisites

Tasks can wait for up to 20 prerequisites, configured in the task center. The scheduler admits them only after every prerequisite completes; missing or cancelled prerequisites keep dependents blocked. Graph updates reject cycles and changes to running tasks, serialize with task controls, and roll back failed saves. Reports include prerequisite blockers. Also fixed the server allowlist for read-only CLI reports (native save dialogs remain desktop-only).

Validation: build and 77 scheduler/localization/report tests passed, plus 8 IPC tests. Three-language production-renderer QA exercised prerequisite editing with no renderer errors. Tests cover ordered admission, cancelled/missing prerequisites, cyclic graphs and persistence failure.

## 12 — Persistent global and project dispatch controls

Added dispatch gates that survive restarts. Users can hold all new task starts or only one project while current workers finish normally. Task-center controls expose both scopes and diagnostic reports explain dispatch blockers. Gates apply to recovered and queued tasks as well as new work; failed persistence restores the previous policy. Existing per-task pause and approval behavior is unchanged.

Validation: build and 79 scheduler/localization/report tests passed, covering active-worker completion during a hold, restart persistence, project isolation and failed saves. Three-language production-renderer QA toggled global dispatch off/on without renderer errors.

## 13 — Atomic multi-stage workflow creation

The task center now includes a 2–12-stage workflow builder with stage editing/reordering, project/model selection and explicit permission defaults. Stages use separate conversations, share workspace files for handoff, and run through automatically generated prerequisite chains. A single persisted batch prevents partial admission; request fingerprints deduplicate creation retries and reject changed reuse of an admitted request. Prepared journals are removed if admission fails. Stage position and workflow name appear on task cards.

Validation: build and 79 scheduler/localization tests passed, including retry deduplication, restart persistence, invalid-directory rejection, save rollback and no-worker-before-admission. Three-language renderer QA submitted two-stage workflows through the actual form with zero renderer errors. No live model calls were made.

## 14 — Per-project concurrency budgets

Projects can now set independent concurrency limits (1–8), alongside the existing global limit. The scheduler reserves slots before starting workers, lets other projects use remaining global capacity, and automatically starts queued tasks when a slot is released. Lowering a limit never kills active work; restoring the global default removes the override. Limits persist across restarts and appear in diagnostic metadata.

Validation: build and 83 scheduler/localization/report tests passed. Added coverage for project isolation, automatic slot reuse, lowering/raising limits, restart persistence and save rollback. Three-language production-renderer QA changed a project's concurrency through the task-center control with no renderer errors. This is scheduler coordination, not an OS filesystem lock against external processes.

## 15 — Previewable workflow handoff reports

Added whole-workflow Markdown/JSON reports with stage states, latest recorded assistant responses, output references, dependency IDs and recovery history. Missing/deleted stages remain explicit and prevent a false completed status. Report generation scans beyond the latest chat page without running a model or reading referenced file contents. Oversized responses and output lists are explicitly marked as truncated. Exports use the exact immutable preview, with a bounded 10-minute cache. Fixed escaped-newline credential redaction by redacting structured string values before JSON encoding.

Validation: full check passed (54 files, 501 passed, 2 Windows-only skipped), including pagination, missing/cancelled stages, truncation, credential redaction and immutable/expired previews. Production-renderer QA passed Chinese/English/Japanese, including Markdown/JSON preview and save dispatch; native OS save-dialog interaction remains a Windows acceptance check.

The user extended the sequence to 20 iterations during round 15, requesting larger capability expansions for the remaining rounds.

## 16 — Standalone Linux supervisor

Added a bundled, Electron-free Linux service with a separate private data directory, authenticated-encryption account vault, kernel `flock` ownership, shared validated approval handling, CLI account import/listing and response commands, and graceful restart persistence. The existing CLI connects over Unix sockets or optional authenticated loopback TCP. Unsupported desktop/unmanaged data is rejected instead of partially loading it. Normal service shutdown preserves runnable intent while explicit user stops remain stopped.

Validation: build and 88 runtime/IPC/scheduler tests passed. The bundled daemon passed a real-process smoke test with the real CLI, singleton rejection, queued task persistence and restart. Native Unix sockets are denied by this test host, so transport acceptance used the loopback TCP option. No real accounts, model calls or Windows release were involved. See SERVER.md for setup and scope.
