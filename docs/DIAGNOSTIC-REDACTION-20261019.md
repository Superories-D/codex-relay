# Diagnostic credential masking — 2026-10-19

The existing field matcher removed only the first word of an unquoted
`Authorization: Bearer <opaque-token>` value, leaving the credential visible.
It also replaced quoted JSON fields with an unquoted marker, making the resulting
JSON invalid for catalog/diagnostic consumers that parse it after redaction.
HTTP URLs containing user information were not masked.

The shared redactor now masks full Bearer/Basic/token authentication values,
proxy authorization, snake/camel-case credential fields and HTTP(S) URL user
information. It preserves string quoting and escaped-value boundaries so valid
JSON remains parseable. Host, port, repository path and ordinary diagnostic
messages remain useful. Existing JWT/key matching and output-length limits stay.

## Verification

- Four of five new tests failed before the fix, covering header values, valid
  JSON, credential-bearing URLs and quoted diagnostic strings. The remaining
  legacy masking/bounds test already passed. Only synthetic strings were used.
- Build and 27 targeted redaction/storage/catalog/RPC tests passed.
- Actual Electron IPC error handling was exercised with an isolated schedule
  save failure containing a synthetic authorization header and URL credentials.
  The visible alert excluded all synthetic credential values while preserving the
  destination. Existing draft/error/retry checks also passed with no page errors
  or inference. Evidence: `qa-output/redaction-native.log` and
  `qa-output/schedules-native-report.json`.
- Full suite: **48 files / 417 tests** passed, recorded in
  `qa-output/redaction-tests.log`; initial
  regression evidence is `qa-output/redaction-before.log`.

This does not promise detection of arbitrary unlabeled secret strings or secrets
split across independent incoming log chunks. No existing logs, user credentials,
Git authentication configuration or installed profile were read or rewritten.
