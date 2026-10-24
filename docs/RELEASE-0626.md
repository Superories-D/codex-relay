# Codex Relay 0.6.26 — Windows task operations

Open **Task center → Task operations** to see why work is waiting and act on its
actual blockers. Inspect account eligibility, prerequisite evidence, ownership
and recovery barriers, then navigate to the task, accounts or pending review.
Request identities prevent an old review from answering a replacement request.

Durable local history connects task families, user stop intent, recovery,
workflow reports and accepted/stored artifact versions. Stable pagination keeps
your place while new observations arrive. Recording failures and downtime gaps
are visible; re-enable recording explicitly without resuming paused tasks.

Four languages and Windows zoom are supported. A dedicated SQLite worker keeps
history writes off the main thread. A 100,000-event fixture verified complete
history retention, restart and query behavior. Transient Windows state-file
locks now receive identity-checked retries that preserve the old destination.

CLI detection/official installation, user-owned Telegram Bot notifications,
delivery center and full ZIP64 delivery vault remain included. Linux-specific
development is paused. Windows packages remain unsigned.

Full delivery: Setup EXE, Portable EXE, unpacked ZIP, INSTALL.txt and
SHA256SUMS.txt. All are complete files without splitting. See
[behavior, validation and limits](OPERATIONS-COCKPIT-20261025.md).
