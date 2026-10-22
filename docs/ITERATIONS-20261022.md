# Ten sequential iterations — 2026-10-22

Each iteration is validated and pushed before the next begins. These are source changes; no new binaries or native installation.

## 1. Connection lifecycle recovery

Initialization exits, output EOF, pipe errors and RPC timeouts now propagate typed recoverable failures, including events before a worker subscribes. Pending RPCs settle immediately; invalid executable/configuration errors retain their identity. Targeted transport/worker tests and build pass.

## 2. Persistent recovery history

Chats now retain the latest 50 recovery events, including retry, reconnection, stop and completion. Expandable localized history survives restart; details are redacted and bounded. Recovery-save rollback also restores its history. Build, scheduler/history/redaction/localization tests and Chinese/English/Japanese renderer checks passed.

## 3. Editable pending-message queue

Stable message IDs and queue revisions support editing, removing and reordering pending inputs. Stale views are rejected. Queue writes are durable before normal completion may drain them; failed writes restore the original queue. Pending text enters the transcript only when admitted. Build and 78 scheduler/storage/localization tests passed; three-language renderer checks exercise reorder/edit/remove.
