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

1. **Windows verifiable delivery loop (release acceptance).** Declare artifact acceptance rules
   before execution, verify actual files after completion, persist evidence and
   failures, prevent failed delivery from unblocking dependent tasks, and prepare
   an explicit repair follow-up. Include Windows desktop interfaces, restart
   durability, exportable evidence and native/local acceptance. Fold large-diff
   review performance into this milestone rather than releasing it alone.
2. **User-owned Telegram Bot notifications on Windows (user requested).** Audit
   reusable existing Telegram transport code. Add an understandable Bot connection
   setup, recipient binding, notification choices and an explicit test action.
   Cover completion, failed delivery acceptance, approval/input waiting, quota
   waiting and recovery. Verify retries, deduplication, restart durability and
   privacy controls. Keep Bot secrets in encrypted storage; no notifications are
   sent until the user explicitly configures and enables the connection.
3. **Workflow delivery and recovery.** Connect declared acceptance to downstream
   admission and workflow handoff reports. Preserve evidence across retries and
   account recovery; distinguish executed tasks, accepted artifacts and evidence
   that has gone stale. Extend Telegram access to these results after the core
   notification workflow is accepted.

Every milestone includes complete Windows Setup, Portable and ZIP artifacts,
instructions and SHA256 checksums. Upload through the authorized LAN Gitea API
and download attachments again for verification. No splitting to accommodate
proxy limits. Keep the installed running app and existing accounts intact.
Account-free tests remain the default; new inference is not implied by this plan.
