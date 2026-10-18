# v0.6.17 — branch workflow and runtime reliability

Windows x64 update requested by the user after the current verified milestone.
This packages all source changes since v0.6.16. Installation remains the user's
action; no installed application, real profile or credentials were replaced.

## Included changes

- Search, switch and create Git branches from Changes; create remote-tracking
  branches, show Worktree occupancy, preserve dirty content on failed checkout,
  and reject stale branch operations. Japanese and other UI languages supported.
- Keep public reasoning summaries through completion and history hydration;
  show a localized empty state instead of raw empty JSON.
- Coalesce concurrent same-account credential refreshes and wait for pending
  refresh processes during task shutdown. Cleanup failures retain recovery gates.
- Correct nested agent identity and stale turn handling; recover missing CLI
  interruption events only after confirming process shutdown.
- Improve concurrent terminal admission, tab closing and process cleanup.
- Recover scheduled task admission without duplication; retain MCP catalog and
  authorization lifecycle; preserve Git filename identity and project isolation.

Detailed evidence: `GIT-BRANCHES-20261018.md`, `REASONING-SUMMARY-20261018.md`,
`ACCOUNT-REFRESH-20261018.md`, `NESTED-AGENTS-20261018.md`,
`STOP-RECOVERY-20261018.md`, `TERMINALS-20261018.md`,
`SCHEDULES-20261018.md`, `EXTENSIONS-20261018.md`, `GIT-WORKSPACE-20261018.md`.

## Verification

- Build passed; full suite **384 tests / 43 files** passed. Final small UI
  corrections were rebuilt and verified in the actual packaged executable.
- Packaged executable reports `isPackaged=true`, app version `0.6.17`, EXE
  product version `0.6.17.0`. Windows encryption roundtrip, named-pipe API,
  navigation and empty-account behavior passed, with no renderer errors.
- Packaged Japanese Git UI passed actual stage/unstage/restore/commit/push
  against a local bare remote, then branch-name error recovery, Unicode creation,
  local switching, remote tracking, search and Worktree occupancy checks.
- Packaged Chinese/Japanese summary rendering passed. Four-language concurrency
  settings, validation, persistence, reload and Japanese native menu checks passed.
- All packaged JS/CSS bundles match `dist`; private QA/runtime/release/Git data
  are excluded. ZIP CRC, embedded app.asar and EXE hash comparison passed.
- Installer reached installation options in 571 ms, recognized the existing
  all-users directory, and was closed without clicking Next or Install.
- Initial Windows resource edit failed. Editing a temporary copy of this build's
  EXE succeeded; verified version information before copying it back. NSIS/ZIP
  packaging from that verified directory then completed with exit code 0.
- No model inference requests or real-account refresh tests. Synthetic protocol
  fixtures establish local behavior, not real-account concurrent relay acceptance.

The application and installer are not publisher-signed. Broader readiness gaps
remain documented in `RELEASE-READINESS.md`, including the earlier live task's
output acceptance, full quota-reset cycle and deeper real-account combinations.
Publishing this update does not claim those gaps are complete. The user requested
pausing further iteration after this release.

## Artifacts

Directory: `release/desktop-0.6.17/`. Release tag: `v0.6.17`.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `Codex-Relay-Setup-0.6.17-x64.exe` | 125224637 | `42411664CFC035D4A9E75C1DD90B9AD52DBF1617AC9F0CC952CEB7D48B91E1E6` |
| `Codex-Relay-Unpacked-0.6.17-x64.zip` | 167240170 | `D27984F2965A673D04005448659E2B44ED4012D628CF99AFD658AC80A382082C` |

Install notes and SHA256SUMS accompany the binaries. Exit the client before
upgrading; keep the original installation scope and directory. Extract the ZIP
fully if using the alternative distribution. Binaries remain outside Git.

Ignored evidence under `qa-output/`: `release-0617-tests.log`,
`package-0617-final.log`, `package-0617-integrity.json`,
`zip-0617-integrity.json`, `installer-probe-0617.json`, `windows-0617.log`,
`git-0617.log`, `reasoning-0617.log`, `concurrency-0617.log` and their native
reports/screenshots. Publishing records and downloaded asset hash checks are
recorded separately in `release-published.json` and `release-publish-0617.log`.
