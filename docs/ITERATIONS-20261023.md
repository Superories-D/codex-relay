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
