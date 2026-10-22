# Linux headless server

The source now includes an Electron-free Linux supervisor. It reuses the same CLI worker, account rotation, recovery checks, approvals, queue and persistent scheduler as the desktop application. Windows desktop automation and importing existing desktop windows are not part of this entry point.

## Start

Requirements: Linux, Node.js 24 (the runtime used for validation), `flock` from util-linux, and the official Codex CLI installed on PATH or supplied with `--cli /absolute/path/to/codex`.

```sh
npm ci --ignore-scripts
npm run build
npm run serve -- --data-dir "$HOME/.local/share/codex-relay-server"
```

The data directory is created with mode 0700 and must belong to the service user. Use a separate directory from the desktop app. Account vaults use AES-256-GCM and an owner-only `server-master.key`; preserve both the vault and this key when backing up. Losing the key loses access to the stored credentials. The service does not migrate Windows DPAPI vaults.

`--check` verifies storage, key permissions and the ownership lock without starting task scheduling. The kernel ownership lock releases after process termination; no stale PID file is trusted. A live second instance cannot claim the same root.

Where Unix sockets are unavailable, use `--ipc-port 7898`. This authenticated JSONL endpoint binds only to 127.0.0.1. Supply the same `--ipc-port` to the CLI. The token is read from the private data directory, never printed by the service.

## Manage through the CLI

Run these commands on the server (for example over SSH):

```sh
node scripts/relay.cjs import-account --file /private/path/auth.json --label Primary --data-dir "$HOME/.local/share/codex-relay-server"
node scripts/relay.cjs accounts --data-dir "$HOME/.local/share/codex-relay-server"
node scripts/relay.cjs run --cwd /srv/project --prompt-file /private/path/task.txt --data-dir "$HOME/.local/share/codex-relay-server"
node scripts/relay.cjs status --json --data-dir "$HOME/.local/share/codex-relay-server"
node scripts/relay.cjs approvals --data-dir "$HOME/.local/share/codex-relay-server"
node scripts/relay.cjs respond --file /private/path/response.json --data-dir "$HOME/.local/share/codex-relay-server"
```

Import an official ChatGPT `auth.json` obtained through the official CLI's normal authentication flow. API-key billing is not used. `approvals` returns the current request, including job ID; `respond` takes the same explicit response object as the desktop command, for example `{"id":"REQUEST_ID","jobId":"JOB_UUID","value":{"decision":"decline"}}`. Input questions also require the current `historyId` and the requested answers. No request is automatically approved.

SIGINT/SIGTERM stops owned workers with the existing process-confirmation checks, saves runnable work for the next service start, and preserves explicit user pauses/cancellations. If process shutdown cannot be confirmed, the supervisor stays alive and reports the failure. Unexpected termination uses the existing ownership/recovery checks on the next start.

## Verification scope

`node scripts/qa/headless.cjs` launches the bundled daemon, connects the real CLI through authenticated loopback TCP, checks singleton ownership, submits an account-free task and verifies persistence after restart. It does not call a model. Unit/integration tests cover the vault, tampered ciphertext, key permissions and unsupported desktop state. Existing supervisor integration tests cover real synthetic JSONL worker processes and interruption recovery. Live Codex subscription inference still requires acceptance testing on the intended server.

## Authenticated HTTP and live status

```sh
npm run serve -- --data-dir "$HOME/.local/share/codex-relay-server" --http-port 7899 --workspace /srv/project
ssh -L 7899:127.0.0.1:7899 user@server
```

Repeat `--workspace` to allow additional creation roots. Paths are resolved through symlinks; roots must not overlap the private service data directory. This is a task-admission restriction, not an OS sandbox or a multi-tenant security boundary. Existing task controls are operator-level capabilities.

The HTTP endpoint binds only to loopback. It requires `Authorization: Bearer <http-token>` using the owner-only `http-token` file in the server data directory. Tokens are not accepted in URLs, and cross-origin browser calls and non-loopback Host headers are rejected. The HTTP token persists across restarts. The Unix/TCP IPC token remains a separate credential. Do not expose these operator credentials in public pages or repository files.

- `GET /api/meta`: configured creation roots and supported commands.
- `GET /api/snapshot`: current scheduler state.
- `GET /api/events`: authenticated SSE snapshots and heartbeat comments; reconnecting receives the latest complete snapshot.
- `POST /api/command`: JSON `{ "name": "...", "args": ... }`, response `{ "result": ... }` or an HTTP error with `{ "error": ... }`.

For task creation use `job.submit` with `{ "requestId": "UUID", "input": { ...NewJob } }`. Exact retries return the same retained job; reuse with different input is rejected. This prevents duplicate work after a lost response. Other mutations are never automatically replayed by the service. `workflow.add` has its own persistent request ID. Available operations cover task controls, queued messages, approvals, paged chat, dependencies, dispatch, project limits and reports. Credential import and native file dialogs are not exposed over HTTP.

Requests are capped at 1 MiB with bounded in-flight commands, status streams and buffered output. The HTTP tests exercise real loopback requests, SSE, origin/authentication rejection, symlink escape and concurrent duplicate submissions.

## Remote browser console

After forwarding the HTTP port, open `http://127.0.0.1:7899/` and enter the server's HTTP token. The console has responsive phone/desktop layouts and Chinese, English and Japanese text. It supports task creation, workflow creation, realtime task states, automatic recovery notices, paged chat, follow-up queues, pause/resume/cancel, global dispatch control, and explicit approvals/input answers. Workflow reports download through the browser after preview.

The token and unsent task draft stay in this browser session; Disconnect removes them. SSE reconnects automatically without replaying mutations. A submission whose response was lost retains its request ID and can be reconciled from live snapshots or retried under that same ID. Closing the browser does not stop server tasks. Chat is plain text in this console; no model-produced HTML is executed, and a strict same-origin CSP applies.

`RELAY_CHROMIUM_PATH=/path/to/chromium node scripts/qa/remote-ui.cjs` exercises the built browser UI against the real bundled server using synthetic account-free tasks. It covers lost creation acknowledgements, initial SSE failure/reconnection, task/chat controls, workflow submission, reload and 390/900/1280px layouts. OS-specific browser and live-subscription acceptance remain separate.
