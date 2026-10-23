# Twenty further iterations — 2026-10-23

Continuation from commit 2e9e76c. Each numbered round is validated, committed and pushed before the next. Windows native acceptance is distinguished from Linux execution and renderer fixtures.

## 21 — Cross-platform operational health

Desktop IPC and authenticated server HTTP now share a privacy-preserving health summary: state counts, recovery backlog, queued messages, approvals, dispatch hold, uptime and memory. It provides monitoring data without conversation text, filesystem paths or account identities. Validation: build and health/HTTP tests.

## 22 — Transactional runtime configuration

Both Windows desktop settings and Linux HTTP settings now use scheduler-serialized configuration. Active/recovering process ownership blocks replacement; failed disk writes restore previous settings. This closes the old desktop in-memory/disk mismatch and gives Linux a supported configuration API. Validation: build and scheduler tests, including persistence failure and active-worker rejection.

## 23 — Remote pending-message workbench

Linux web users can now edit, remove and reorder queued instructions using the same revision-checked queue as Windows. Per-task priority controls use the same persistent scheduler ordering. Switching conversations remounts queue edit state so drafts cannot migrate to another task. Validation: build, scheduler and localization suites.

## 24 — Remote full-history investigation

The remote conversation menu now opens the shared full-history search dialog: role filters, pagination, bounded excerpts and original-message inspection. Backend validation requires a known task and bounds query/offset/detail sizes; results remain credential-redacted over HTTP. Validation: build, chat-history and localization tests.

## 25 — Server-side reusable instructions

The remote composer now supports the shared versioned task-template manager. Templates persist on the Linux host, can be reused across browser sessions, and reject stale concurrent edits. Applying a template updates the draft and model without submitting a task. Validation: build, template persistence/concurrency and localization tests.

## 26 — Remote runtime configuration panel

A localized settings dialog exposes CLI path, concurrency, polling, retry timing and interruption-continuation instructions, plus a live health report. Unsaved edits remain local; save uses the transactional scheduler gate and retains input on errors. Validation: build and localization audit. Native desktop settings continue to use the same backend gate.

## 27 — Headless installation doctor

Linux is now recognized as a supported CLI platform in shared environment checks. Added offline `--doctor`, authenticated live diagnostics in the web settings panel, and remote CLI `doctor`/`health` commands. Checks resolve the configured executable and inspect its version without login or inference. Validation: build, diagnostics, remote-CLI and localization tests.

## 28 — Windows multi-monitor session restoration

Desktop window position, normal size and maximized state now persist through an atomic serialized store. Startup clamps geometry to a connected monitor, including negative-coordinate displays and smaller laptop screens after undocking. Corrupt geometry falls back safely. Validation: build and geometry tests; native multi-monitor window interaction remains Windows acceptance work.

## 29 — Actionable Windows approval notifications

Desktop notifications now include new approval requests and correctly notify when automatic recovery ends in manual attention without changing the underlying task state. Request identity/content deduplicates repeated snapshots. Clicking a notification opens its conversation, not merely the last selected tab. Validation: build and notification transition tests; real Windows toast delivery remains native acceptance work.

## 30 — Explicit desktop background and privacy controls

Added localized preferences for tray-only startup, close-to-tray versus safe exit, active-task sleep prevention, and hiding task names in native notifications. Preferences roll back when persistence fails. Startup only hides after the tray exists; choosing exit follows existing process-confirmed shutdown. Validation: build, desktop storage and localization tests. OS tray/power/toast integration needs Windows acceptance.

## 31 — Bounded cross-platform conversation exports

Windows and Linux now share a chronological export pipeline with credential redaction, safe code fences, duplicate-message handling and explicit size truncation. Windows writes atomically; web users download Markdown directly. Export scans history beyond the current page and never reads referenced files. Validation: build, export pagination/redaction/bounds and localization tests.

## 32 — Unified remote task control center

The remote console now hosts the shared task center: project/state filters, recovery summaries, scoped bulk pause/resume with per-task results, prerequisite editing, project dispatch holds and concurrency budgets. Workflow building/reports remain accessible from the same surface. Validation: build, scheduler and localization tests; browser acceptance is included in the final integrated pass.

## 33 — Durable task organization across platforms

Remote users can rename, pin, archive and restore conversations; pinned tasks sort first and archived tasks have an explicit view. Desktop metadata edits now use the same serialized, rollback-safe scheduler operation. Active or automatically recovering tasks cannot be hidden by archiving. Validation: build, scheduler rollback/active-archive and localization tests.

## 34 — Workflow drafts survive reload and unknown responses

The shared Windows/web workflow builder now saves validated session drafts, stage order and the original submission ID. It persists identity before sending, reuses it after reopening, and reconciles admitted workflows from snapshots. Successful admission clears the draft; storage failure blocks submission. Validation: build, draft corruption/identity and localization tests; final browser QA exercises reload and lost acknowledgements.

## 35 — Reproducible Linux launch configuration

Added strict versioned JSON startup configuration with config-relative paths, bounded files and explicit CLI override rules. Workspace lists, data location, ports, CLI and Telegram opt-in can be deployed without a long service command. Unknown fields and empty/invalid CLI ports fail early. Validation: build and config precedence foundations/path/validation tests.

## 36 — Standalone Linux distribution

Added a reproducible allowlisted server packaging command: bundled daemon/web assets, both control CLIs, service/configuration samples, docs, license and per-file SHA-256 manifest. The distribution runs on Node 24 without Electron or an on-host dependency install. Runtime data is excluded. Validation: build, package creation, manifest verification and a real packaged `--check` process with isolated private storage.

## 37 — Windows/Linux remote connection launcher

Added a shell-free OpenSSH launcher with validated host/port arguments, loopback-only forwarding, host-key verification, keepalives and clean signal forwarding. Both server distributions and Windows installer resources include the remote CLI and tunnel helper. Validation: argument-injection/port tests and `--check`; no real SSH destination was contacted.

## 38 — Observable graceful service draining

Shutdown now blocks new admissions before stopping Telegram or workers. Authenticated readiness reports `stopping` with HTTP 503; commands receive a retryable 503 rather than a misleading validation error. Already-admitted commands finish before process-confirmed shutdown, retaining the original restart semantics. Validation: build and real HTTP/runtime drain tests. Clients keep stable submission IDs across these responses.
