# v0.6.24 — Windows delivery center and stale-evidence gates

Complete release node:
[v0.6.24](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.24).
Linux-specific development remains paused. The next Windows functional milestone
builds on v0.6.22 acceptance and v0.6.23 Telegram notifications; see
[delivery center usage and verification boundaries](DELIVERY-CENTER-20261025.md).

Task Center now opens a delivery center for project/workflow filtering, reusable
acceptance plans, full-file evidence inspection, explicit batch reacceptance and
workflow-aware evidence exports. A passing size/existence rule no longer hides
that its artifact bytes changed: inspection invalidates matching old evidence,
persists an attention hold and prevents new dependent tasks from starting.
Explicit reacceptance alone releases that hold. Historical results remain visible.

Plans preserve task prompts, models and drafts. Confirmation retains reviewed
target/plan revisions despite live snapshot updates. Batch records survive restart,
distinguish skipped/unverified outcomes, isolate cancellation and stop on disk
failure. Reports and Telegram notices reflect stale evidence consistently.

Also prevents an aggregate pass when separate checks for one path observed
different file bytes, and fixes native-dialog viewport sizing at 150% CSS zoom
without shrinking the enlarged text. These are part of the functional milestone,
not separate UI-only releases.

Validation: full Windows regression, **599 passed / 43 platform skips, 83 files**;
build/typecheck; actual Windows Electron filesystem/scheduler/export/plan/restart
checks; four-language delivery center, acceptance and Telegram UI checks; packaged
and portable startup; installer wizard; complete ASAR/ZIP integrity and full
attachment readback. No inference or external Bot messages are sent by QA.

Distribution includes full Windows x64 Setup, Portable, Unpacked ZIP, INSTALL.txt
and SHA256SUMS.txt. Packages remain unsigned. The running installed app and
existing accounts are preserved. Evidence is a point-in-time observation, not
immutable artifact storage; real-account concurrency/relay and broader Desktop
parity gates remain open. Next major target: Windows delivery vault and portable
handoff bundles containing actual verified artifacts.
