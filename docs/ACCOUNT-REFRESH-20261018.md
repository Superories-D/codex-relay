# Concurrent account refresh — 2026-10-18

Previously, same-account refresh requests were serialized but each launched a
new refresh process. They now share the in-flight operation and its result or
failure. A later independent request still performs a new refresh; different
accounts remain independent. Existing per-account serialization and external
Desktop ownership checks remain in effect.

Refresh-process cleanup failure now carries `ProcessSafetyError` into the worker
and scheduler recovery gate. Worker close stops accepting server requests and
waits for already accepted requests, including a refresh running in its separate
process. Thus a late cleanup failure cannot arrive after the job released its
ownership. Close continues to report that failure even if the main process has
already exited. Successful refresh responses are not sent to a closing process.

Validation:

- Final combined build and full suite passed: 380 tests across 42 files.
- Account tests verify coalesced success/failure, later retries, independent
  accounts and cleanup failure. Worker tests cover immediate and late safety
  failures, waiting during close and refusal of new refreshes while closing.
- `tests/accounts-process.test.ts` runs actual local JSONL subprocesses with
  synthetic credentials through production RPC and process cleanup. Eight
  concurrent requests launch one process. It verifies encrypted vault writeback,
  plaintext removal, PID exit and owner-file removal. Failure after rotation
  retains the newer staged credentials; retry uses those rather than the older
  vault value.
- The fixture uses a temporary AES-GCM cipher through the production vault
  interface, not Windows DPAPI or real credentials. No account network traffic
  or model inference occurs. Real concurrent account refresh/relay and the full
  quota reset cycle still require separate acceptance.

Source after v0.6.16; existing installer, installed profile and credentials are
unchanged. This does not establish the exact cause of the earlier installed
client stop failure; see `STOP-RECOVERY-20261018.md`.
