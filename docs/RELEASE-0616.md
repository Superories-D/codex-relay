# v0.6.16 — composer refinement, concurrency and Japanese

Includes the verified UI follow-up (`83baab2`), independent conversation
concurrency (`050050b`) and Japanese localization (`e589537`). The user installs
the update; this run did not replace the installed application or real profile.

## User-visible changes

- Compact model/effort popover positioned above the input; themed permission
  menu with keyboard navigation; pasted/dropped images have draft previews.
  The one-line composer stays 48 CSS px, about 82px including its footer.
- Settings → General → Concurrent tasks: default 3, configurable 1–8. Independent
  conversations can run together, including with one account. Parent/adopted-child
  conversations sharing a runtime remain serialized. Controls and approvals are
  routed to their own task. Lowering the limit does not interrupt running tasks.
- Japanese language option, 1,044 catalog translations, system-locale detection,
  Japanese font fallbacks and localized native menus/dates. Original user content,
  code and paths remain intact.

Details: `COMPOSER-POPOVERS-20261018.md`, `CONCURRENCY-20261018.md`,
`JAPANESE-20261018.md`.

## Verification and limits

- Build/typecheck passed. Full test suite: 36 files / 333 tests passed. Final
  Japanese label/font adjustments also passed focused localization and visual QA.
- Concurrent real **local protocol fixtures** use separate OS processes and
  threads; pause isolation and completion persistence passed. Unit coverage adds
  slot changes, family exclusion, approval ID collisions, quota rotation,
  credential-refresh serialization, Desktop exclusivity and shutdown failures.
  **Real-account concurrent inference/refresh/relay is not yet accepted.** Existing
  single-task live relay is not evidence for these parallel cases.
- electron-builder completed NSIS + ZIP with exit 0. Executable product version
  is `0.6.16.0`. The application has no publisher certificate signature.
- The actual packaged application started with isolated account-free profiles:
  `isPackaged=true`, version 0.6.16, Windows encryption roundtrip, authenticated
  named-pipe status and settings navigation passed, no renderer errors.
- Packaged settings verified all four languages, limit validation/persistence,
  Japanese native File-menu construction and renderer reload. Native menu
  construction was inspected without activating Close/Quit roles.
- Packaged OS clipboard file/image paste, drag/drop, draft image preview and
  reduced motion passed; original clipboard was restored. Packaged long-history
  scrolling/resizing/zoom, input growth/shrink and reading-position checks passed
  in Simplified Chinese, Traditional Chinese and English. Japanese light/dark,
  narrow window, 150% scale and popover interaction were checked in the renderer.
- All five packaged JS/CSS bundles match local `dist`. Private QA/runtime/release/
  Git directories are excluded from app.asar. ZIP CRC and its app.asar comparison
  against the unpacked application passed.
- Installer reached the installation-options page in 1,052ms and detected the
  existing all-users install at `D:\codex-relay\Codex Relay`. The probe never
  clicked Next or Install and closed only its own process. Actual upgrade remains
  the user's action; no existing credential or profile was overwritten.
- All verification in this update used zero model requests. Wider release gates
  remain in `RELEASE-READINESS.md`, including earlier task-output acceptance.

Local ignored evidence: `japanese-tests.log`, `windows-smoke.json`,
`concurrency-native-report.json`, `composer-native-report.json`,
`scroll-native-report.json`, `package-0616-integrity.json`,
`zip-0616-integrity.json`, `installer-probe-0616.json` under `qa-output/`.

## Artifacts

Directory: `release/desktop-0.6.16/`.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `Codex-Relay-Setup-0.6.16-x64.exe` | 125205173 | `54DC055A6EDA8CFB316B26518342EC050180D6CFB3610F8A93DF68B7F9DDF728` |
| `Codex-Relay-Unpacked-0.6.16-x64.zip` | 167214607 | `60C97942FBB90420BC8692FD9EB5F46BC46980DCE1A25E37738E36CF8CD941D5` |

Exit the existing client before updating. Keep the original all-users installation
scope and path. The ZIP is a complete alternative application directory; extract
fully before starting `Codex Relay.exe`. Checksums and Chinese installation notes
are provided alongside the artifacts. Binaries and private QA data are not committed.
