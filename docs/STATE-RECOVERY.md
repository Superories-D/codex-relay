# State generations and offline inspection

Windows desktop and Linux server retain `state.previous.json`, the previous successfully committed application-state generation. Both files are atomically replaced with owner-only permissions. A backup write failure prevents primary replacement. This is a recovery aid, not a full backup: encrypted vault keys, chats, runtime homes, templates and workspace files are separate.

`node scripts/inspect-state.cjs --data-dir /private/relay-data` validates both generations and prints only counts, timestamps, sizes and hashes. It does not decrypt accounts, expose prompts, acquire control of workers or modify files. Exit 1 means the primary state is unreadable or invalid.

A corrupt primary intentionally blocks startup. Relay never silently restores the older generation: that could resurrect cancelled tasks or replay work whose receipt existed only in the newer state. Stop Relay and verify that its owned workers have stopped before any manual recovery. Preserve a copy of the entire private data directory first. Compare generations and workspace/native conversation evidence before restoring; treat jobs from an older generation as requiring manual reconciliation, not as automatically safe to run. Keep global dispatch paused until that review is complete. Vault data from Windows and Linux is not interchangeable.

### 工作流交付条件恢复（2026-10-27）

批量工作流创建与返工分支保留原交付验收条件，分支不继承旧报告。前序阶段只有状态完成且当前验收证据有效时，才能作为返工交接前提。旧版批量创建时落在未使用字段中的条件会在加载时迁移：已完成且无进程恢复门禁的任务先进行只读产物核查，不伪造通过报告；存在原进程恢复要求时保持该门禁。用户后来修改的验收条件优先保留。
