# Round 04 — Recoverable bulk archive

Task Center now separates current and archived tasks and can archive eligible visible selections or restore archived selections. Archive preserves records. Restoration changes only archive metadata and does not start a task. Archived tasks expose no pause/resume or dependency mutation controls. Saved views include archive scope, with existing views defaulting to current tasks.

The authenticated `jobs.archive` command carries up to 100 UUID/revision pairs. The scheduler serializes each batch behind prior controls, waits for scheduler ticks, validates eligibility and observed archive revision, and persists the accepted subset in one save. Running/family-active, recovery-pending, unmanaged and stale tasks receive individual rejections. Actual filesystem failure rolls back accepted archive values and revisions; success receipts are returned only after save.

Undo uses only exact successful IDs and their returned archive revisions. Legacy single-task archive operations increment the same persisted revision, so restoring and rearchiving a task elsewhere prevents an older undo from overwriting the newer choice. Failed rows stay selected; hidden selections are disclosed and never silently added to a batch.

Validation: 18 task tests passed, including real filesystem failure/rollback/retry, reload persistence, stale undo after legacy operations, serialized metadata changes, strict input bounds and authenticated HTTP roundtrip. TypeScript reported no errors in these files at validation time; unrelated concurrently edited UI files were still in progress. Root performs the final whole-tree build and browser checks.

Integration: the workspace.write IPC schema now accepts the optional SHA256 expectedHash and forwards it to the file editor backend for Round 06, coordinated with that feature's owner.
