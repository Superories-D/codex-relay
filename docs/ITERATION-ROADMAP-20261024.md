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
5. **Windows operations cockpit (v0.6.26 release gate).** Bring task-family
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
   Complete attachment upload/readback is the remaining publication gate. See
   `OPERATIONS-COCKPIT-20261025.md`.
6. **Windows recovery domains (next substantial goal).** Investigate separating
   unrelated-project recovery from task admission while retaining strict shared
   account, session-family and process ownership. Build a reviewable recovery
   plan with explicit user intent, durable evidence and restart behavior. First
   establish which barriers are genuinely global; do not merely remove a safety
   wait or claim isolation from a UI explanation. Include actual concurrent
   runtime fixtures, failure paths and complete Windows release acceptance.

Every milestone includes complete Windows Setup, Portable and ZIP artifacts,
instructions and SHA256 checksums. Upload through the authorized LAN Gitea API
and download attachments again for verification. No splitting to accommodate
proxy limits. Keep the installed running app and existing accounts intact.
Account-free tests remain the default; new inference is not implied by this plan.
