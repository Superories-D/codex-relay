# Preserve unsupported file encodings — 2026-10-19

The file preview previously decoded any non-NUL byte sequence with forgiving
UTF-8 conversion. Shift-JIS and other undecodable text could appear as replacement
characters and then be saved as corrupt UTF-8. A regression reproduced this on
synthetic Japanese bytes before the fix (`qa-output/file-encoding-before.log`).

Preview now uses strict UTF-8 decoding while preserving a valid BOM. Undecodable
files show an explicit localized encoding message and retain the external-open
control. They do not expose an inline edit button. The write endpoint independently
rechecks the current file's type/encoding, rejects unsupported formats and retains
the existing modification-time guard; hiding the UI is not the only protection.

## Evidence

- Build/typecheck and 11 targeted desktop/translation checks passed.
- File tests verify legacy Japanese bytes, truncated UTF-8 and UTF-16/NUL data
  remain byte-identical after preview and attempted writes. Valid UTF-8 Japanese,
  Chinese, emoji, a literal Unicode replacement character, BOM and CRLF retain
  exact bytes through the core read/write path.
- `scripts/qa/file-encoding-native.cjs` passed in actual Electron, using isolated
  empty-account data. Chinese/Japanese unsupported-encoding messages rendered,
  the edit button was absent, external-open remained available, and a direct IPC
  write was rejected without changing the original bytes. A Japanese UTF-8/BOM
  file was edited and saved through the actual editor. No renderer errors or
  inference requests. Evidence: `qa-output/file-encoding-native-report.json`,
  `qa-output/file-encoding-native.log`, `qa-output/file-encoding-native-ja.png`.
- Full regression suite: **48 files / 419 tests** passed, recorded in
  `qa-output/file-encoding-tests-final.log`. The earlier run was interrupted and
  had no final result; its process handle was missing and no matching process
  remained before the final run was started.

No encoding is guessed or converted automatically. Built-in editing of arbitrary
legacy encodings remains unsupported. Existing external-editor access remains;
it was not launched during QA. The core exact-byte test preserves supplied line
endings; it does not promise that browser textarea edits preserve every original
line ending. Existing external filesystem race limits and file-size bounds remain.
The installed client and v0.6.17 release artifacts are unchanged.
