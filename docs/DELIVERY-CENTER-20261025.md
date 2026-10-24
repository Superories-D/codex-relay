# Windows delivery center — 0.6.24

Open Task Center → Delivery Center. This Windows milestone joins reusable
acceptance plans, full-file evidence inspection, stale-proof holds, explicit
reacceptance, batch history and workflow evidence export. Linux-specific adapters
remain paused and are not part of this release.

## Check the evidence, not only the last status

The task list shows recorded acceptance, its timestamp and configured check
count. It does not claim that a historical passing result proves the files are
still unchanged. Filter projects or workflows, select tasks across 30-row pages
and choose **Inspect delivery evidence** to reread their complete files.

Inspection compares actual SHA256 fingerprints with the current accepted report,
independently of whether its conditions would still pass. Replacing a nonempty
file with another nonempty file therefore invalidates old evidence even though
both versions satisfy an existence/size condition. Changed or unconfirmed proof
is saved against the matching contract revision and report ID. A completed task
becomes attention-required and new dependent tasks remain blocked.

Inspection does not silently accept changed outputs. **Reverify selected tasks**
explicitly records new evidence and updates the scheduler. A passing recheck can
release the hold created by acceptance, previously queued messages and dependent
task admission. User pause/cancel intent and unrelated errors remain effective.
Restoring original bytes and inspecting again does not itself release an earlier
hold: explicit reacceptance is required. Running/recovering families are skipped
with a reason, rather than inspected as idle deliveries.

All reads use the existing path/junction bounds, complete streaming SHA256,
UTF-8 validation, typed JSON checks, cancellation and mutation detection.
Multiple checks of one normalized artifact path must observe consistent hashes;
replacement between individually successful reads makes the combined result
unverified. JSON parsing remains bounded at 4 MiB; full-file hashing is not
truncated. I/O failure or the existing two-minute verification deadline yields
unverified evidence. Inspection is explicitly requested, not a filesystem watch
service or an atomic filesystem snapshot. Files may change after it finishes.

Stale evidence is also reflected by conversation acceptance summaries, task
diagnostics, workflow completion/export and Telegram attention notices. Historical
passing records remain available, but cannot falsely complete a workflow while
their evidence is invalidated.

## Reuse a plan without replacing a conversation

A named acceptance plan contains a description and the same four check types:
file/size, text literal, SHA256 and typed JSON Pointer. Create one from selected
task checks, or edit its conditions with the ordinary check editor. The plan
editor does not create or send a task. Applying a plan replaces only selected
tasks' acceptance contracts; prompts, models and conversation drafts are kept.
Relative paths are evaluated independently in each task directory.

Confirmation captures task IDs, titles, revisions, the selected plan and library
revision. It keeps that reviewed selection when newer snapshots arrive. Changes
by another operation are rejected rather than silently overwriting the new
contract. Results are per task: busy, removed or changed tasks can fail while
other targets apply successfully. Review the displayed results before proceeding.
Applying a plan to a completed task requires fresh acceptance before its
dependents can proceed.

`delivery-plans.json` is atomically written in the protected Windows desktop
data directory. A failed write preserves the prior in-memory and on-disk library;
corrupt or unsupported data is refused without overwriting the original file.
Plans are independent of prompt templates, so the same artifact checks can be
used with different task instructions.

## Durable batches and exports

One batch runs at a time. Each target becomes `checking` on disk before its file
operation starts. The journal records outcomes, comparison, contract/report
identity, actual fingerprints, size, file time, task directory, dependencies and
workflow stage identity. Cancelling aborts only this batch's verification signal;
it does not cancel another manual verification. The scheduler checks contract
and report identity again after waiting for control ownership.

Restart converts unfinished journals to interrupted history instead of silently
replaying acceptance that might release task scheduling. Select targets again to
run a new batch. Disk failure stops the coordinator with a visible issue. The
scheduler's own acceptance record remains authoritative if a later batch-journal
write fails; a historical batch cannot undo a committed task result.

**Export batch evidence** downloads the complete retained batch as JSON. It
includes declared checks and observed hashes, not embedded artifact file bytes.
Selected stages are identified explicitly; a finished batch is not a claim that
every workflow stage or its model work completed. The existing workflow report
remains available for overall task completion and missing-stage reporting.

Bookkeeping bounds are 100 plans, 30 checks per plan/task, 100 targets per batch,
20 retained batches and 30 display rows per page. They do not truncate artifact
bytes or split/reduce release packages. The per-task report history remains the
latest ten checks; exported files can preserve earlier evidence separately.

## Verification

The full Windows regression passes with dedicated tests for actual file hash
changes, stale evidence persistence and rollback, dependent-task holds/release,
revision ownership, cancellation, corrupt journals, interrupted recovery and plan
write failure. Multi-check consistency also has a real-file replacement test.

`delivery-center-native.cjs` runs actual Windows Electron with an isolated profile
and zero accounts. It reads real files, holds a resumed dependent in the queue
after invalidation, permits account waiting only after explicit reacceptance,
downloads and parses an actual evidence file, applies a plan while preserving
the user's prompt and pause intent, and restarts to verify persistence.

`delivery-center-ui.cjs` exercises the production Windows renderer in four
languages, light/dark layouts and 150% zoom, including pagination, nested editor
focus, failed-save draft retention, fixed confirmation revisions, JSON downloads
and viewport bounds. It found/fixed a shared native-dialog viewport problem under
ancestor CSS zoom. Existing acceptance and Telegram UI flows are rechecked.

These checks do not use real-account inference or send external Bot messages.
Complete Setup, Portable, ZIP, instructions and SHA256 checksums plus packaged
native acceptance and attachment readback are required distribution gates.
