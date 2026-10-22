# Ten sequential iterations — 2026-10-22

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
