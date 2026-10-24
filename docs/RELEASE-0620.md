# v0.6.20 — compact model controls

Windows x64 delivery: [v0.6.20](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.20).
Published from `f154ddd`; all five attachments were downloaded and matched local
SHA256 values. Actual packaged application passed two launches at version 0.6.20;
portable startup/exit and the upgrade wizard passed. All 86 ZIP files match.
ZIP generation follows NSIS packaging because NSIS adds `resources/elevate.exe`;
the initial parallel ZIP was rejected by verification and repaired before upload.
Complete Setup EXE, Portable EXE and unpacked ZIP are supplied with `INSTALL.txt`
and `SHA256SUMS.txt`; no binary splitting. Existing v0.6.19 CLI bootstrap and
Git review changes are retained.

The model picker now starts with a compact effort panel, with a separate model
list and explicit default row. Effort editing preserves the default model;
switching to an incompatible model uses its default effort. Keyboard navigation,
nested Escape, focus after catalog arrival and bounded retry after startup
failures are covered. Details and primary accessibility reference:
[model picker evidence](MODEL-PICKER-20261024.md).

Source validation: build/typecheck; 80 test files, 546 passed and 43 platform
skips; seven production-renderer viewport/theme/language combinations; delayed
catalog, failure/retry and account-switch focus checks. These are account-free
checks and send no inference. Release acceptance also checks the actual packaged
and portable executables, installer wizard, bundled resources, full ZIP and
attachment downloads. Distribution hashes are attached to the release.

The running installed application and existing accounts are not replaced during
QA. Publisher signing and the broader open [acceptance gates](RELEASE-READINESS.md)
remain outstanding; sustained iteration continues.
