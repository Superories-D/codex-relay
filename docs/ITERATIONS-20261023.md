# Twenty further iterations — 2026-10-23

Continuation from commit 2e9e76c. Each numbered round is validated, committed and pushed before the next. Windows native acceptance is distinguished from Linux execution and renderer fixtures.

## 21 — Cross-platform operational health

Desktop IPC and authenticated server HTTP now share a privacy-preserving health summary: state counts, recovery backlog, queued messages, approvals, dispatch hold, uptime and memory. It provides monitoring data without conversation text, filesystem paths or account identities. Validation: build and health/HTTP tests.

## 22 — Transactional runtime configuration

Both Windows desktop settings and Linux HTTP settings now use scheduler-serialized configuration. Active/recovering process ownership blocks replacement; failed disk writes restore previous settings. This closes the old desktop in-memory/disk mismatch and gives Linux a supported configuration API. Validation: build and scheduler tests, including persistence failure and active-worker rejection.
