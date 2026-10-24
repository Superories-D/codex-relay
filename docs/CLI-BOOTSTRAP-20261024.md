# Automatic CLI preparation — 2026-10-24

Desktop startup and the Linux daemon now detect a usable Codex CLI before
dispatching tasks. They first try the configured executable, PATH, an existing
Relay-managed runtime and standard user installation locations. Detection runs
`--version`; finding a filename alone does not establish a usable installation.

If detection fails, Relay downloads the official standalone installer over HTTPS,
runs it without interactive prompts and verifies the resulting CLI. The managed
release is **0.162.1**, the app-server version used by this project's protocol
validation. Usable existing installations are reused without upgrade/uninstall.
The standalone installer avoids requiring npm or a separate Node installation on
Windows. Linux/macOS installers need the normal system download/archive tools.

Read official sources on 2026-10-24:

- [CLI installation](https://learn.chatgpt.com/docs/codex/cli)
- [Windows CLI deployment](https://learn.chatgpt.com/docs/enterprise/windows-deployment)
- [Installer environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)

The runtime and installer cache live under the application's
`runtime/managed-cli` directory. The official installer may expose its bin
directory in the user's PATH. Its isolated `CODEX_HOME` keeps installation cleanup
away from existing user runtimes and credentials. The app saves the verified
absolute executable path, so the running process does not need a PATH refresh.

Concurrent preparation requests share one operation. Installation uses fixed
subprocess arguments, bounded HTTPS script download, a ten-minute process limit
and the official installer's asset verification. Task dispatch and quota warmups
wait for readiness. On exit, Windows stops the process tree; Unix installers use
a dedicated process group and require descendant shutdown confirmation. An
unconfirmed stop retains a failure gate instead of starting another installer.
Download/install errors do not mark the CLI ready or save an unverified path.

The desktop and authenticated remote UI display checking, downloading,
installation and verification phases. Failure includes expandable error details,
retry and a pointer to the existing CLI path setting. Saved tasks and drafts
remain accessible. Linux `--check` and `--doctor` remain read-only and do not
auto-install. Authenticated API/IPC clients can use `cli.status` and `cli.ensure`.

## Evidence

- Build/typecheck passed; full Windows suite: **546 passed, 43 platform skips**
  across 80 files. Targeted installer/setup/dispatch suite: **93 passed**.
- Real official Windows installer downloaded and installed CLI 0.162.1 into an
  isolated directory. Verification and durable selection passed. A second check
  reused it; only one installation occurred. The QA-only PATH entry was removed
  afterward, with the original user PATH verified unchanged.
- Two real Electron launches with an empty profile reused that installation,
  restored the configured executable, reached ready and made no new managed
  install. No accounts, logins or model turns were used.
- Production-renderer Chromium checks passed in simplified/traditional Chinese,
  English and Japanese, light/dark at 900/1280 pixels: progress, detailed errors,
  retry, readiness dismissal and usable composer. No renderer exceptions.
- Tests cover missing CLI, non-PATH discovery, concurrent requests, failed
  verification/persistence, retry, oversized/failed download, redacted process
  failure, shutdown and the dispatch gate. An existing recovery timing case
  timed out during one concurrent run and passed in isolation and in the full
  final run; its assertion/timeout was not weakened.

Ignored evidence: `qa-output/cli-install-native-report.json`,
`cli-startup-native-report.json`, `cli-setup-ui-report.json`,
`cli-setup-full-tests.log`, `cli-setup-*.png`. Real Windows installation is proven;
the Linux integration still needs equivalent native acceptance. This checkpoint
does not replace the existing cross-account/live-model acceptance gates.
