# Sustained iteration roadmap — 2026-10-24

The user requires a continuous loop: identify a substantial goal, implement and
verify it end to end, commit/push and publish complete release artifacts, then
identify the next goal. Do not stop at isolated UI tweaks. The goal is active.

**2026-10-25 steering:** Linux-specific development is paused at the user's
request. Focus current and subsequent milestones on Windows. Preserve the Linux
delivery adapter separately; do not resume it without new user direction.
Saved Linux adapter: Git stash `2879ef2a5c9a733cb685139374327c1d7c270169`
(`Paused Linux delivery integration at user request 2026-10-25`). The earlier
mixed-platform UI harness is retained under ignored QA output; active acceptance
checks now run the four Windows layouts only.

1. **Windows verifiable delivery loop (published v0.6.22).** Declare artifact acceptance rules
   before execution, verify actual files after completion, persist evidence and
   failures, prevent failed delivery from unblocking dependent tasks, and prepare
   an explicit repair follow-up. Include Windows desktop interfaces, restart
   durability, exportable evidence and native/local acceptance. Fold large-diff
   review performance into this milestone rather than releasing it alone.
2. **User-owned Telegram Bot notifications on Windows (published v0.6.23).** Audit
   reusable existing Telegram transport code. Add an understandable Bot connection
   setup, recipient binding, notification choices and an explicit test action.
   Cover completion, failed delivery acceptance, approval/input waiting, quota
   waiting and recovery. Verify retries, deduplication, restart durability and
   privacy controls. Keep Bot secrets in encrypted storage; no notifications are
   sent until the user explicitly configures and enables the connection.
   Windows native/UI verification, complete packaging/readback and anonymous
   full installer download passed. See `TELEGRAM-WINDOWS-20261025.md`.
3. **Windows workflow delivery center (published v0.6.24).** Build on the
   accepted per-task contracts and notification outbox: reusable acceptance
   plans, cross-task artifact inspection, stale-evidence detection, batch
   verification and workflow-level evidence export. Preserve failure/repair paths
   and downstream admission through restart/account recovery. This must include
   functional scheduling/evidence behavior, not only a dashboard or smaller UI
   changes. Reuse existing templates and workflow reports where appropriate.
   Implementation, 599 Windows regression checks, native scheduler/filesystem/
   download/restart and four-language UI now pass. Complete packaged acceptance
   and release readback passed. See `DELIVERY-CENTER-20261025.md`.
4. **Windows delivery vault and portable handoff bundles (published v0.6.25).**
   Preserve actual verified artifact bytes in versioned local deliveries, with
   complete manifests, fingerprints and workflow provenance. Produce a portable
   handoff bundle that can be independently inspected without a model account.
   Make copying, interrupted recovery, changed-file rejection and disk failure
   explicit; never silently truncate artifacts to fit a limit. Reuse the current
   acceptance plans, evidence reports and private Telegram notices. Verify actual
   large files, tamper detection, export and restart before a complete release.
   Independent versions, verified ZIP64 archives, offline inspection, restart
   reconciliation and native four-language acceptance are implemented. Real
   5 GiB source / >5 GB ZIP64 readback and independent extraction passed.
   Current-source regression passed 641 checks with 43 platform skips. Packaged
   native acceptance, forced-crash recovery, two CLI startups, Telegram emulator,
   portable startup, Setup wizard and full ASAR/88-file ZIP validation passed.
   All five complete attachments passed LAN readback/SHA. Anonymous full Setup
   download/SHA passed after a ranged resume; public Portable/ZIP sizes passed.
   Source/tag/main: `043f036457ef9281f6835814a52ce81800017178`.
   See `DELIVERY-VAULT-20261025.md`.
5. **Windows operations cockpit (published v0.6.26).** Bring task-family
   activity, approvals, recovery, quota waiting, accepted artifacts and notification
   outcomes into one actionable timeline. Build on existing scheduler evidence;
   do not invent success from UI state or silently resume paused work. Include
   direct navigation to actual blockers, durable history and account-free native
   verification before a complete release. Research current desktop workflows
   and validate useful behavior beyond a visual dashboard. Functional scheduler
   explanations, exact review identities, durable SQLite observations, stable
   pagination and real evidence navigation are implemented. Current-source
   checks: 664 passed / 43 platform skips. Actual native four-language flows,
   recording failure/retry, restart, synthetic review UI and 100,000-event
   history checks passed. Complete packaged acceptance passed: operations,
   two CLI startups, vault crash recovery, Telegram emulator, delivery center,
   portable and Setup wizard. Ten ASAR bundles and all 88 ZIP files match.
   All five full attachments passed LAN download/SHA readback; anonymous full
   Setup download/SHA and public binary sizes passed. Source/main/tag:
   `ae405bb8c772aa5c9d9fbf6d35a4c91932d1d611`. See
   `OPERATIONS-COCKPIT-20261025.md`.
6. **Windows recovery domains (published v0.6.27).** Investigate separating
   unrelated-project recovery from task admission while retaining strict shared
   account, session-family and process ownership. Build a reviewable recovery
   plan with explicit user intent, durable evidence and restart behavior. First
   establish which barriers are genuinely global; do not merely remove a safety
   wait or claim isolation from a UI explanation. Include actual concurrent
   runtime fixtures, failure paths and complete Windows release acceptance.
   Native creation-time job assignment, per-run receipts, process creation
   identities, canonical-home ownership, scoped admission and the recovery-plan
   interface are implemented. Current-source regression: 672 passed / 43 skips.
   Fourteen actual native ownership/scheduler checks, restart/save failure,
   legacy fallback, Cancel persistence and four native UI locales pass. Full
   packaged acceptance passed, including the packaged native host, eight QA
   flows, Setup wizard, ten ASAR bundles and all 89 ZIP files. All five full
   attachments passed LAN download/SHA; anonymous full Setup download/SHA,
   public binary sizes and complete metadata downloads passed. Source/main/tag:
   `36889676461fea7e83cf6546e6837bf70f789321`. See
   `RECOVERY-DOMAINS-20261025.md`.
7. **Windows recoverable workspace checkpoints and task branches (published v0.6.28).**
   Preserve a reviewable source/index/worktree state before isolated task
   branches, carry intended uncommitted changes without overwriting the original,
   and restore a checkpoint into a new worktree after interruption. Connect the
   snapshot, task context and delivery provenance. Preserve ignored-file choices,
   actual Windows path/byte semantics and stale-state guards. Verify restoration
   using real Git repositories, changed and untracked files, index differences,
   large data and restart before publishing a complete Windows release.
   Capture/restore, independent Git objects, durable publication/recovery,
   idempotent restore requests, paused task provenance, full file pagination and
   the native interface are implemented. Repository/service tests cover conflicts,
   split/sparse indexes, flags, submodules, nested repositories, unborn and SHA-256
   repositories, source removal, tampering, cancellation and storage failure.
   Final regression passes696tests/43platformskips. All nine packaged Windows
   flows plus the Setup wizard pass, including complete64MiB/159-entry checkpoint
   restore, source-review cancellation, paused tasks, restart and four locales.
   Ten JS/CSS bundles/native helper match the build and all89 ZIP files match.
   All five complete attachments passed upload/download SHA readback; anonymous
   full Setup download and public binary sizes/metadata bytes pass. Main/tag:
   `3a99e6342ed4ee80f5fe10a1a9c7bfa165f63175`. See
   `WORKSPACE-CHECKPOINTS-20261025.md`.
8. **Windows task handoff and branch review (in progress after v0.6.28).** Turn a
   completed isolated task into a reviewable handoff: compare checkpoint base,
   current source and task results; build an integrated proposal in a fresh
   worktree; expose conflicts and acceptance evidence before adoption. Bind every
   action to freshly reviewed repository/index/file identities. Preserve dirty
   source work, pause/cancel intent and checkpoint/delivery provenance. Adoption
   of an existing workspace must be an explicit guarded action with recoverable
   evidence, never an implicit overwrite. Validate real divergent repositories,
   conflicts, large binary/Unicode content, stale reviews, restart and Windows
   locales before the next full release. Begin implementation after the .28
   publisher has captured its clean release source.
   Production source now includes retained archives, streamed raw snapshots,
   explicit checkpoint bases, two-parent candidate worktrees, structured/manual
   and whole-tree conflict resolution, missing-receipt recovery and a durable
   asynchronous service with main IPC. Native proof covers full8MiB/Unicode bytes,
   untouched original indices, private GC and cancellation/process cleanup.
   Fresh candidate acceptance and paused continuation admission now bind criteria
   revisions, full bytes, durable plans/proofs/receipts and Scheduler validation;
   seven admission regressions, ten native flows and actual Electron creation/
   resolution/acceptance/admission/restart all pass. The four-language review UI
   passes synthetic and actual Electron checks, including150%zoom. Full content
   review, actual child proposals/assembly, root/child ignored setup choices and
   explicit independent retries are implemented. Latest combined regression is
   30PASS; mounted graph regression3PASS, actual graph Electron4flows and mounted
   Electron2flows pass. The adoption foundation adds a managed native file helper,
   complete metadata/byte guards, a multi-file journal and per-path recovery;
   native10checks, managed4checks, transaction/recovery6checks and existing native
   process-domain15checks pass. A durable read-only original-source preview now
   connects source recapture, actual mounted inventories, full fingerprints and
   restartable pagination to the product UI. Focused service proof, four-language
   layouts and actual managed Git paths beyond260characters pass. Repository
   metadata locks and prepared ref verification cover fresh source admission;
   complete current regression and actual Electron preview proof are tracked in
   QA output. Source application/recovery now connects complete protected plans,
   explicit new-file/omitted-setup policies, actual confirmation, native moves,
   unchanged Git staging and independent per-path recovery to the product UI.
   New-file permissions inherit from the reviewed target directory with stale-ACL
   refusal. Actual Electron application/recovery/restart5checks and mounted source
   preview4checks pass, application renderer4layouts pass, focused regression28checks
   pass. Native helper12checks and transaction/recovery7checks pass; independent
   recovery-label inspection2checks passes. Forced-crash lease reconciliation,
   new-directory/link/structural operations, missing-role/format/
   topology choices and packaged release acceptance remain required. This milestone
   is still in progress and no .29 release has been published. See
   `TASK-HANDOFF-20261025.md`.

Every milestone includes complete Windows Setup, Portable and ZIP artifacts,
instructions and SHA256 checksums. Upload through the authorized LAN Gitea API
and download attachments again for verification. No splitting to accommodate
proxy limits. Keep the installed running app and existing accounts intact.
Account-free tests remain the default; new inference is not implied by this plan.
