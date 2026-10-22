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
