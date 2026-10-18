# v0.6.15 — compact desktop UI

Packages the UI work in `ba8fced` and `7e92f3e`, following the user's explicit
request to build an update they will install themselves. No installed resources,
credentials or real user profile were replaced. The long-term Goal stays paused.

## Changes

- Neutral dark/light desktop surfaces, tighter project navigation, clearer
  project/title hierarchy and aligned message/composer columns.
- A 48 CSS px single-line input strip with attachment and send/stop controls;
  project, permission and model controls sit in a separate footer. Strip plus
  footer measures about 82px in the checked layouts. Multiline text grows/shrinks.
- Collapsed completed import summaries and compact, expandable activity details.

Implementation and interaction evidence: [UI polish](UI-POLISH-20261018.md) and
[compact composer](COMPACT-COMPOSER-20261018.md).

## Package validation

- Source build passed; the preceding UI revision passed 36 test files / 324 tests.
  This packaging step only changes package/lockfile versions to 0.6.15.
- electron-builder completed the Windows x64 NSIS and ZIP build with exit code 0.
  Initial Windows version-resource write failed transiently; builder retried and
  the final executable product version was checked as `0.6.15.0`.
- Packaged Electron actually started with an isolated account-free profile:
  `app.isPackaged=true`, version 0.6.15, Windows encryption roundtrip, authenticated
  named pipe, settings navigation and empty-model state passed, no renderer errors.
- Packaged executable passed the native three-language scroll/resize/zoom,
  composer growth/shrink, inspector, reading-position and image-layout checks.
  Zero accounts and zero model requests were used.
- All five packaged JS/CSS bundles match local `dist` bytes. QA, runtime, release
  and Git directories are absent from app.asar. ZIP CRC verification passed and
  its app.asar matches the unpacked program.
- The final NSIS installer reached the installation-options page and detected
  the existing all-users installation at `D:\codex-relay\Codex Relay`. The probe
  did not click Next or Install and closed only its own installer process.
  First probe misclassified Chinese window text because Windows PowerShell read
  the UTF-8 script without a BOM; Unicode-escaped matching fixed the probe, and
  the repeat reported `wizard-ready` in 543ms. This verifies wizard loading, not
  completed installation or upgrade; the user will perform installation.
- Artifacts have no publisher certificate signature.

Local ignored evidence: `qa-output/windows-smoke.json`,
`scroll-native-report.json`, `package-0615-integrity.json`,
`zip-0615-integrity.json`, `installer-probe-0615.json`.

## Delivery

Directory: `release/desktop-0.6.15/`.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `Codex-Relay-Setup-0.6.15-x64.exe` | 125147879 | `D8D6B7A9CC06FB4F75D99EFC2E8680FB3C9EF6335656A444633F9C89854A3701` |
| `Codex-Relay-Unpacked-0.6.15-x64.zip` | 167127124 | `40F0D8A90971C3E0D6704F9988E90C5E0727C580D6FCC3A01F2C9B406F00F0FF` |

For the installed client, finish any active work and exit the application before
running Setup. Keep the existing all-users installation scope and original path.
The ZIP is an alternative complete application directory: extract fully, then
run `Codex Relay.exe`. Binary packages and private QA data are not committed.
