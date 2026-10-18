# Durable schedule editing — 2026-10-19

Creating, editing or deleting a schedule previously mutated the in-memory list
before saving `desktop.json`. A disk failure could therefore leave a newly
enabled schedule active after the UI reported failure, change the task prompt
without a successful save, or remove a task only until the next restart.

Schedule edits now enter the desktop write queue, construct the next schedule
list, atomically write it, and only then publish it to in-memory state. Existing
task objects retain their identity for admission bookkeeping. Other schedules
remain independently runnable; only their short persistence operations share the
desktop write queue. Ordinary desktop saves serialize state when their queued
write starts, so a preference save queued behind a successful deletion cannot
resurrect an obsolete schedule list.

## Verification

- Two regression tests failed against the previous implementation, demonstrating
  an unsaved new task remaining enabled and an unsaved edited prompt/paused state
  remaining in memory. Evidence: `qa-output/schedule-storage-before.log`.
- Three storage tests now cover failed create/edit/delete, retry, delayed writes,
  concurrent independent schedule and preference updates, preservation of saved
  state, and deletion followed by a queued desktop save. They inject failure at
  the atomic rename boundary and independently reload the persisted file.
- Build/typecheck and 25 targeted schedule/calendar/desktop tests passed.
  Full regression suite: **47 files / 412 tests**, recorded in
  `qa-output/schedule-storage-tests.log`.
- Real Electron/Japanese UI passed controlled create/edit/delete write failures,
  visible error messages, retained drafts, reopening the saved prompt, retry
  without duplicates, and deletion surviving renderer reload. The existing
  admission, wake, weekly-template and pause tests also passed, with no renderer
  errors, accounts or inference. Evidence: `qa-output/schedules-native-report.json`
  and `qa-output/schedule-storage-native.log`.

Native QA uses a one-shot rename failure scoped to the isolated profile's
`desktop.json`. No installed profile, system permissions or actual credentials
were changed. Initial harness attempts corrected nested-label matching and used
the Electron runtime's built-in module accessor for fault injection; application
guards were not weakened.

These changes cover editable schedule definitions. They are not a claim of
cross-file transactions for all application state or physical power-loss testing.
Existing occurrence-reservation recovery remains separately documented in
`SCHEDULES-20261018.md`.
