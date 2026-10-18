# Release readiness — v0.6.17 checkpoint

User goal: 持续迭代该项目，让各项功能达到可正式发布的水平。
The goal was explicitly reactivated after v0.6.15 delivery. Preserve the original
scope: a usable Codex Desktop-style client backed by the real Codex CLI, account
relay, subagents, multilingual interaction and responsive UI. The user additionally
requires concurrent tasks across multiple threads.

The latest user instruction is to publish v0.6.17 after this milestone and then
stop. Further iteration is to be paused after publication; the incomplete gates
below remain open and must not be treated as achieved by publishing an update.

This is an acceptance ledger, not a claim of release readiness. Existing handoff,
`DESKTOP-PARITY.md` and live-validation documents remain evidence; a green mock
test cannot replace actual CLI or installed-client evidence.

| Requirement | Current evidence / next acceptance gate |
| --- | --- |
| UI and input ergonomics | v0.6.16 packages screenshot follow-up fixes; native image draft/clipboard and packaged scroll checks passed. Later source preserves streamed public reasoning summaries, shows localized empty states and passes Chinese/Japanese Electron rendering; see `REASONING-SUMMARY-20261018.md` |
| Concurrent independent tasks | Implemented 1–8 slots (default 3), family exclusion, per-task control/approvals and shutdown. Unit and real local JSONL-process checks passed; see `CONCURRENCY-20261018.md`. Real-account concurrent inference/refresh/relay remains unverified |
| Account refresh and relay | Existing real same-thread single-task relay observed. Missing CLI interrupt events fall back to confirmed process close before relay; see `STOP-RECOVERY-20261018.md`. Same-account refresh now shares an in-flight operation; worker shutdown waits for refresh and preserves cleanup failures. Actual local subprocess rotation/retry/encrypted storage verified with synthetic credentials; see `ACCOUNT-REFRESH-20261018.md`. Real-account concurrent refresh/rotation, the exact earlier installed stop failure and full reset-cycle behavior still require evidence |
| Subagents | Existing live parent/child flows verified. Nested graph identity and child turn ordering corrected after v0.6.16; deterministic real subprocess root/child/grandchild quota relay, preserved Goal accounting and targeted continuation/interruption passed. See `NESTED-AGENTS-20261018.md`. Real-account deep hierarchy, cross-account recovery and Goal combinations remain incomplete. Related threads sharing a runtime home must not race |
| Real CLI execution and task outputs | Real execution exists. Previous completed live task's output is still pending acceptance; completion status is not output correctness |
| Goals | Existing lifecycle evidence retained. Cross-account and deep subagent combinations remain open |
| History and files | Paginated import and original-record integrity verified. 632 imported histories lack source/ancestors and remain explicitly read-only; never invent recoverable context |
| Git/Worktree | Real-Git and Japanese Electron file/index/commit/local-remote-push checks passed; see `GIT-WORKSPACE-20261018.md`. Branch search/switch/create, explicit remote tracking, Worktree occupancy and stale-request rejection passed real Git and packaged UI checks; see `GIT-BRANCHES-20261018.md`. Hunk staging, advanced branch/conflict operations, PR workflows and remote-error recovery remain open |
| Terminal | Concurrent admission, pending-start shutdown, close retry, input isolation and translated lifecycle state implemented after v0.6.16. Six lifecycle tests and real account-free CLI/Electron two-PTY Japanese UI, simultaneous close and process-exit checks passed; see `TERMINALS-20261018.md`. Arbitrary detached user processes remain outside this evidence |
| Plugins/MCP | Persistent catalog, account-free local Skills/MCP management, OAuth completion and safe shutdown implemented after v0.6.16. Actual CLI 0.162.1 + Electron + local MCP/OAuth fixture passed tool/resource calls, UI lifecycle, callback/token exchange and separate-home authorization discovery. Remote plugins, provider-specific OAuth/refresh and model-driven usage remain open; see `EXTENSIONS-20261018.md` |
| Scheduled tasks | Source after v0.6.16 adds admission deduplication, durable restart recovery and worktree reuse. Ten targeted tests and real account-free Electron admission/Japanese UI lifecycle passed; actual scheduled inference/output and sleep/clock behavior remain open. See `SCHEDULES-20261018.md`; existing packages are unchanged |
| Multilingual/accessibility | Japanese added with 1,044 catalog entries; four-language switching/persistence and Japanese native menu construction verified. Narrow/zoomed light/dark Japanese layouts passed; see `JAPANESE-20261018.md` |
| Packaging | v0.6.17 NSIS wizard + packaged app + ZIP integrity verified, including branch workflow, summary display and four-language concurrency settings; see `RELEASE-0617.md`. User performs installation. Publisher signing remains open |

Operational constraints: inspect the real installed profile only through the
documented Explorer Desktop Shell helper because of MSIX AppData dual views.
Never disclose or commit credentials. Do not overwrite current tokens from old
backups. Changes are verified then committed and pushed at concrete milestones.
No quota-consuming test is authorized merely by reactivating the goal; continue
local and account-free checks and request a bounded live test only when needed.
