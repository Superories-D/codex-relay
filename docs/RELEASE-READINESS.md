# Release readiness — active iteration, 2026-10-24

2026-10-25 Windows scope: the user paused Linux-specific development. v0.6.22
published verifiable delivery and large-diff review with complete artifacts.
The next substantial milestone is `RELEASE-0623.md`: user-owned Telegram Bot
notifications, system-encrypted durable outbox, rate limits, uncertain effects,
recipient isolation and Windows system networking. Windows build, 584 passed /
43 platform skips, four-language UI and real Electron system encryption,
transport, scheduler notice and restart against a local Bot emulator passed.
No external Bot message or inference was sent. Complete packaging/readback
remains a release gate. Linux adapters remain separately preserved. Next:
Windows workflow delivery center under `ITERATION-ROADMAP-20261024.md`.

User goal: 持续迭代该项目，让各项功能达到可正式发布的水平。
The goal was explicitly reactivated after v0.6.15 delivery. Preserve the original
scope: a usable Codex Desktop-style client backed by the real Codex CLI, account
relay, subagents, multilingual interaction and responsive UI. The user additionally
requires concurrent tasks across multiple threads.

The user explicitly resumed sustained iteration and requires commit, push and a
complete release at every verified milestone. The goal is active. v0.6.19 ships
complete Setup, Portable and ZIP files plus instructions/checksums; all five
attachments passed download verification. LAN Gitea upload avoids the previous
public upload limit without splitting artifacts or changing server configuration.
See `RELEASE-0619.md`. Windows acceptance: 546 passed / 43 platform skips;
actual CLI installation, packaged and portable startup and Git review verified.
The incomplete gates below remain open and are not achieved by publication.

Historical shutdown constraint (superseded by the user's resumed work): at 2026-10-18 23:32 (Asia/Shanghai), the user allowed another
160 minutes and instructed stopping if the objective remains unfinished. Stop by
2026-10-19 02:12 local time, reserving the final five minutes for verified commits,
pushes and handoff. This deadline does not authorize quota-consuming tests or
turn unverified requirements into completed work.

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
| Context usage | Source after v0.6.17 preserves CLI `last` separately from cumulative totals. Old records show current usage as unavailable; four-language Electron rendering and 401 tests passed. See `TOKEN-USAGE-20261018.md`. This is the latest supplied snapshot, not a streaming token estimator |
| History and files | Paginated import and original-record integrity verified. 632 imported histories lack source/ancestors and remain explicitly read-only; never invent recoverable context |
| Git/Worktree | Real-Git and Japanese Electron file/index/commit/local-remote-push checks passed; see `GIT-WORKSPACE-20261018.md`. Branch search/switch/create, explicit remote tracking, Worktree occupancy and stale-request rejection passed real Git and packaged UI checks; see `GIT-BRANCHES-20261018.md`. Source after v0.6.17 serializes managed operations per canonical Worktree and rejects stale branch/index/text-diff mutations; see `GIT-CONCURRENCY-20261018.md`. Text-hunk stage/unstage now passes real Git, Japanese keyboard/mouse UI and the 397-test suite; see `GIT-HUNKS-20261018.md`. Individual-line staging, unrestricted concurrent external edits, advanced branch/conflict operations, PR workflows and remote-error recovery remain open |
| Terminal | Concurrent admission, pending-start shutdown, close retry, input isolation and translated lifecycle state implemented after v0.6.16. Six lifecycle tests and real account-free CLI/Electron two-PTY Japanese UI, simultaneous close and process-exit checks passed; see `TERMINALS-20261018.md`. Arbitrary detached user processes remain outside this evidence |
| Plugins/MCP | Persistent catalog, account-free local Skills/MCP management, OAuth completion and safe shutdown implemented after v0.6.16. Actual CLI 0.162.1 + Electron + local MCP/OAuth fixture passed tool/resource calls, UI lifecycle, callback/token exchange and separate-home authorization discovery. Remote plugins, provider-specific OAuth/refresh and model-driven usage remain open; see `EXTENSIONS-20261018.md` |
| Scheduled tasks | Admission deduplication, durable restart recovery and worktree reuse passed ten targeted tests and real account-free Electron/Japanese UI checks; see `SCHEDULES-20261018.md`. Later source corrects DST recurrence, persists/reprojects system zones and checks due tasks on resume; four additional admission cases, four real Node clock cases and the Electron resume listener passed. See `SCHEDULE-CLOCK-20261019.md`. Actual scheduled inference/output and physical OS sleep/provider recovery remain open; existing packages are unchanged |
| Multilingual/accessibility | Japanese added with 1,044 catalog entries; four-language switching/persistence and Japanese native menu construction verified. Narrow/zoomed light/dark Japanese layouts passed; see `JAPANESE-20261018.md` |
| Packaging | v0.6.17 NSIS wizard + packaged app + ZIP integrity verified, including branch workflow, summary display and four-language concurrency settings; see `RELEASE-0617.md`. Existing release now includes binary volumes uploaded through the user-provided HTTP origin and downloaded with matching SHA256. User performs installation. Publisher signing remains open |

Operational constraints: inspect the real installed profile only through the
documented Explorer Desktop Shell helper because of MSIX AppData dual views.
Never disclose or commit credentials. Do not overwrite current tokens from old
backups. Changes are verified then committed and pushed at concrete milestones.
No quota-consuming test is authorized merely by reactivating the goal; continue
local and account-free checks and request a bounded live test only when needed.

Additional schedule durability gate: `SCHEDULE-STORAGE-20261019.md` records
persist-before-publish create/edit/delete behavior, controlled atomic-write
failure regressions and real Electron draft/error/retry verification. This does
not replace the open scheduled-inference or physical-suspend requirements.

Latest code checkpoint: `35d82ed`, build/typecheck and **48 files / 419 tests**
passed. Diagnostic authentication masking now preserves valid JSON and masks
complete headers/HTTP URL user information; see `DIAGNOSTIC-REDACTION-20261019.md`.
File previews reject unsupported encodings instead of corrupting their bytes;
core UTF-8/BOM checks and actual Chinese/Japanese Electron preview/edit passed;
see `FILE-ENCODING-20261019.md`. New source milestones are not in the unchanged
v0.6.17 release binaries.
