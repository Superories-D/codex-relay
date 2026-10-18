# Release readiness — active work

User goal: 持续迭代该项目，让各项功能达到可正式发布的水平。
The goal was explicitly reactivated after v0.6.15 delivery. Preserve the original
scope: a usable Codex Desktop-style client backed by the real Codex CLI, account
relay, subagents, multilingual interaction and responsive UI. The user additionally
requires concurrent tasks across multiple threads.

This is an acceptance ledger, not a claim of release readiness. Existing handoff,
`DESKTOP-PARITY.md` and live-validation documents remain evidence; a green mock
test cannot replace actual CLI or installed-client evidence.

| Requirement | Current evidence / next acceptance gate |
| --- | --- |
| UI and input ergonomics | v0.6.16 packages screenshot follow-up fixes; native image draft/clipboard and packaged scroll checks passed |
| Concurrent independent tasks | Implemented 1–8 slots (default 3), family exclusion, per-task control/approvals and shutdown. Unit and real local JSONL-process checks passed; see `CONCURRENCY-20261018.md`. Real-account concurrent inference/refresh/relay remains unverified |
| Account refresh and relay | Existing real same-thread single-task relay observed. Concurrent refresh/rotation and full reset-cycle behavior still require evidence |
| Subagents | Existing live parent/child flows verified; deep hierarchy, cross-account recovery and Goal combinations remain incomplete. Related threads sharing a runtime home must not race |
| Real CLI execution and task outputs | Real execution exists. Previous completed live task's output is still pending acceptance; completion status is not output correctness |
| Goals | Existing lifecycle evidence retained. Cross-account and deep subagent combinations remain open |
| History and files | Paginated import and original-record integrity verified. 632 imported histories lack source/ancestors and remain explicitly read-only; never invent recoverable context |
| Git/Worktree and terminal | Existing basic native checks; isolation of concurrent projects/worktrees, fuller Git workflows and terminal lifecycle require broader acceptance |
| Plugins/MCP and schedules | Configuration/UI exist; end-to-end plugin calls and full schedule lifecycle remain open |
| Multilingual/accessibility | Japanese added with 1,044 catalog entries; four-language switching/persistence and Japanese native menu construction verified. Narrow/zoomed light/dark Japanese layouts passed; see `JAPANESE-20261018.md` |
| Packaging | v0.6.16 NSIS wizard loading + packaged app + ZIP integrity verified; includes concurrency and Japanese. User performs installation. Signing/release distribution remain separate gaps; see `RELEASE-0616.md` |

Operational constraints: inspect the real installed profile only through the
documented Explorer Desktop Shell helper because of MSIX AppData dual views.
Never disclose or commit credentials. Do not overwrite current tokens from old
backups. Changes are verified then committed and pushed at concrete milestones.
No quota-consuming test is authorized merely by reactivating the goal; continue
local and account-free checks and request a bounded live test only when needed.
