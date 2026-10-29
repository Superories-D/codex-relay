# Round 2 — Task planning workspace

Task Center now supports a persistent board/list choice and priority, recent-update or oldest-first sorting. Four board columns distinguish attention, ready, working and finished tasks; running jobs waiting for approvals appear in attention. Searching includes project paths and workflow titles, Windows project matching is case-insensitive, and filter counts reflect the current search/project scope.

Each card exposes existing real pause/resume, priority and dependency operations. Batch actions use only eligible visible selections and report individual failures, preserve failed selections and disclose hidden selections. Global/project dispatch and concurrency controls remain available in a collapsible settings section. Delivery, operations, workflow reports and checkpoints remain accessible from a dedicated tool row.

The layout adapts from four columns through two to one as usable space shrinks, using existing theme/accent preferences and localized labels. All task operations continue through existing authenticated IPC commands.

Validation: TypeScript build and six task-view tests cover attention, automatic recovery, command eligibility, Windows path scope, search, ordering and saved-view recovery. Integrated browser checks are documented in WINDOWS-WORKSPACE-3.md.

## Durable bulk priority operations

`jobs.priority` now connects the Windows IPC and authenticated server HTTP entrypoints to a single scheduler maintenance transaction. The strict schema bounds the request to 100 UUIDs and one supported priority. Duplicate IDs collapse; missing, archived, completed/cancelled and unmanaged tasks receive individual rejection results. Accepted tasks are saved together after existing controls settle. A filesystem failure rolls back all accepted in-memory changes and returns failures, so no success is reported before durability.

Task Center's bulk selector acts only on visible, selected, eligible tasks. Successful rows are deselected; failed rows and hidden selections remain. The existing single-task priority API keeps its established behavior. Real Store/Scheduler tests cover reload persistence, an actual filesystem rename failure and retry, queued concurrent operations, stale archive state and authenticated HTTP input validation.
