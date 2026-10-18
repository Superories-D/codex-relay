# Concurrent terminal lifecycle — 2026-10-18

Source change after v0.6.16; existing packages and the installed application are unchanged.

Terminal admission now reserves a slot before filesystem/RPC awaits. Starting
terminals count toward the eight-terminal limit and participate in shutdown.
Shutdown rejects new admissions, waits for every close, retains uncertain owners
for retry and resumes admission only if application exit is cancelled. Duplicate
close requests share one operation. A normally exited shell releases its Codex
app-server while retaining its tab, output and exit code.

Input is ordered per terminal. Partial UTF-8 output is decoded across protocol
chunks; bounded output does not start inside a surrogate pair, and invalid/stale
cursors reset to the retained buffer. Startup/exit errors are exposed as state,
not inserted into the shell output.

The UI synchronizes terminal sessions, guards overlapping starts/closes, and uses
functional updates so simultaneous closes cannot resurrect tabs. Reopening a pane
shares an initial start already in flight. A directory/status row and translated
starting/closing/exit/error messages cover English, Japanese and both Chinese
variants. Terminal text remains original. Input is disabled until the shell is
ready and after it exits.

## Verification

- Build passed; full suite passed 363 tests across 40 files.
- Six lifecycle tests cover concurrent capacity, shutdown during RPC startup,
  failed-start release versus retained live owners, all-settled shutdown and
  retry, per-shell input ordering/isolation, split Unicode and exit preservation.
- `scripts/qa/terminals-native.cjs` passed with actual Codex CLI 0.162.1 and
  Electron, an isolated empty profile, and two real PowerShell PTYs. It verified
  separate directories/PIDs/input/output, Japanese UI, hide/reopen without extra
  shells, exit code 7 and owner cleanup, simultaneous tab closes, repeated app
  quit, and disappearance of all recorded app-server and shell PIDs.
- Native report and screenshot: ignored `qa-output/terminals-native-report.json`
  and `qa-output/terminals-native-ja.png`. No accounts or model turns used.

This does not validate real-account concurrent inference, relay or arbitrary
detached user processes. Those remain separate acceptance gates.
