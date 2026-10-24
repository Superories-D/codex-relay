# Cross-platform acceptance, 2026-10-24

The source still identifies as 0.6.17. This validation does not update the previously published Windows installer.

## Fixes

- Include `scripts/remote-store.cjs` in Electron extraResources. A regression test stages only declared resources and exercises remote initialization, private profile persistence and tunnel configuration without network/model calls.
- Redact bare `rt.1.` refresh tokens, including tokens after serialized newline/tab escapes. Cover generic values, conversation exports, diagnostic logs and Linux asset previews/downloads using synthetic credentials.
- Accept a confirmed signal exit racing Windows taskkill completion. Continue rejecting an unconfirmed live child; test both outcomes.
- Give the Windows remote profile test 20 seconds while retaining real PowerShell ACL operations. Measurement showed ten ACL subprocess calls consumed 4.609 seconds of a 4.653-second run, too close to the previous five-second timeout.

## Verification

- Windows build and full suite: **529 passed, 43 platform skips**, no failures (77 files).
- Ubuntu build and full suite: **570 passed, 2 Windows-specific skips**, no failures (77 files).
- Real bundled Linux daemon QA: authenticated CLI, singleton ownership, persistence and restart passed without model calls.
- Chromium remote UI QA: attachment upload/preview/download, lost acknowledgments for task/follow-up/workflow/schedule, paused workflow retry, budgets/settings/search/export and 390/900/1280-pixel layouts passed without model calls.
- Independent production HTTPS mobile browser: login, authenticated API and SSE through the reverse proxy passed. Anonymous API returned 401 and foreign Origin returned 403.
- A supplied real account completed a task with one real child agent, verified arithmetic, and wrote a Chinese/English/Japanese file. Further operational acceptance is recorded separately from automated test claims.

An earlier Linux run found the stock Ubuntu 22.04 Git 2.34 did not support `git worktree list --porcelain -z`. Upgrading the host to Git 2.56 resolved the schedule/worktree test; no assertion was removed. Operators should check this capability before enabling Git worktree schedules.

## HTTPS deployment

`deploy/nginx.example.conf` is an example for an internet-facing TLS proxy in front of the loopback server. Replace its example domain throughout, obtain the webroot certificate before enabling the TLS server, and configure a certificate renewal reload hook. A CDN proxy must connect to the origin using verified HTTPS (e.g. Full strict).

The proxy rejects foreign Origin values before clearing the accepted Origin for the loopback backend. It uses a fixed loopback Host, disables buffering for SSE, and leaves API bearer authentication intact. Port 7899 should remain loopback-only. Keep the HTTP token out of URLs and logs.

Run the service under a dedicated unprivileged user with a private data directory and UMask 0077. Configure a current Node runtime, a separately installed Codex CLI, and explicit allowed workspaces. Import account and Telegram inputs through private files, then remove those transient files after encrypted storage succeeds. Do not copy desktop credentials or runtime state into the release archive.

## Boundaries

Passing tests are evidence for the exercised cases, not a guarantee that every scenario works. One real account cannot establish real quota-exhaustion rotation across multiple accounts. Telegram user interaction must be tested from the authorized user's client; a successful outgoing Bot API call alone does not prove command routing. Voice, arbitrary project-file downloads and server lifecycle administration are not implemented Telegram features. Backups exclude external project directories; see BACKUP.md.

## Additional live acceptance and backup correction

The real-account task was continued after a service restart, and a two-stage file handoff workflow completed. Repeating the same workflow request returned the same task IDs. These were bounded real model calls, separate from synthetic automated QA.

Production backup initially failed: Codex CLI 0.162.1 created a roughly 103 MiB temporary plugin catalog checkout under each task home's `.tmp/plugins`, exceeding the 10,000-entry bound after only three tasks. Backup now excludes only those disposable per-job catalog directories and records each omission. Other temporary files, installed skills/plugins and conversation state remain included. The regression test uses an oversized cache file and verifies restore still preserves a sibling temporary file. Linux build and the backup create/verify/restore/authentication regression passed after this change.

A stopped production backup was then created and authenticated successfully: 446 entries, 23,839,453 original bytes, with three temporary catalog directories and the owner lock excluded. The service was restarted successfully. This live backup was verified; production restoration was not attempted. Isolated restoration is covered by the regression test.
