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

Draining first interrupts file verification, before waiting for accepted HTTP/IPC commands. The current file read finishes and subsequent chunks stop; a large artifact is not read to completion just to exit. A shutdown-interrupted check is recorded as unverified and marked for automatic read-only verification at the next start. Previously paused/cancelled tasks remain held, and explicit per-task verification cancellation does not schedule an automatic retry. The original remote operation receipt is preserved; restart recovery creates separate file evidence rather than replaying that command.

## Verification scope

`node scripts/qa/headless.cjs` launches the bundled daemon, connects the real CLI through authenticated loopback TCP, checks singleton ownership, submits an account-free task and verifies persistence after restart. It does not call a model. Unit/integration tests cover the vault, tampered ciphertext, key permissions and unsupported desktop state. Existing supervisor integration tests cover real synthetic JSONL worker processes and interruption recovery. Live Codex subscription inference still requires acceptance testing on the intended server.

## Authenticated HTTP and live status

```sh
npm run serve -- --data-dir "$HOME/.local/share/codex-relay-server" --http-port 7899 --workspace /srv/project
ssh -L 7899:127.0.0.1:7899 user@server
```

Repeat `--workspace` to allow additional creation roots. Paths are resolved through symlinks; roots must not overlap the private service data directory. This is a task-admission restriction, not an OS sandbox or a multi-tenant security boundary. Existing task controls are operator-level capabilities.

The HTTP endpoint binds only to loopback. It requires `Authorization: Bearer <http-token>` using the owner-only `http-token` file in the server data directory. Tokens are not accepted in URLs. By default, only local Host headers and matching local browser origins are allowed. The HTTP token persists across restarts. The Unix/TCP IPC token remains a separate credential. Do not expose these operator credentials in public pages or repository files.

For a browser console behind an HTTPS reverse proxy, set `--http-origin https://relay.example` together with `--http-port 7899`, or add `"httpOrigin": "https://relay.example"` to the version 1 server JSON config. The URL must be an exact HTTPS origin, without a path, credentials, query or fragment. Relay still listens on loopback; the reverse proxy supplies TLS. Only this configured public Host/Origin is added to the allowlist. Forwarded headers do not grant access.

The proxy must preserve the browser's Origin, bearer authorization and `X-Relay-Server-ID` headers. It may preserve the public Host or rewrite it to the local upstream Host. Forward streaming responses promptly and disable caching/buffering for `/api/events`; Relay sends `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`. No CORS wildcard is enabled. Use a trusted TLS certificate for clients.

- `GET /api/meta`: configured creation roots and supported commands.
- `GET /api/snapshot`: current scheduler state.
- `GET /api/events`: authenticated SSE snapshots and heartbeat comments; reconnecting receives the latest complete snapshot.
- `POST /api/command`: JSON `{ "name": "...", "args": ... }`, response `{ "result": ... }` or an HTTP error with `{ "error": ... }`.

For task creation use `job.submit` with `{ "requestId": "UUID", "input": { ...NewJob } }`. Exact retries return the same retained job; reuse with different input is rejected. This prevents duplicate work after a lost response. Other mutations are never automatically replayed by the service. `workflow.add` has its own persistent request ID. Available operations cover task controls, queued messages, approvals, paged chat, dependencies, dispatch, project limits and reports. Credential import and native file dialogs are not exposed over HTTP.

Requests are capped at 1 MiB with bounded in-flight commands, status streams and buffered output. The HTTP tests exercise real loopback requests, SSE, origin/authentication rejection, symlink escape and concurrent duplicate submissions.

Delivery evidence is available through `delivery.read` (task UUID) and `delivery.repair` (task UUID, generates a repair prompt only). `delivery.run` takes `{ "requestId": "UUID", "id": "TASK_UUID", "revision": 1, "reportId": "LATEST_REPORT_UUID" }`; omit `reportId` only when no prior report exists. It checks both expectations inside the scheduler before reading files and returns a durable action receipt. Retry the identical payload to recover its result; an uncertain or pending receipt is retained without replay. A succeeded receipt means the verification operation finished; inspect `result.reports` to see whether the files passed.

`delivery.save` takes `{ "requestId": "UUID", "id": "TASK_UUID", "revision": 1, "checks": [...] }`. It requires the current contract revision, validates all relative paths and preserves previous reports without treating them as evidence for the new revision. The web console's delivery panel edits these conditions, verifies files and displays the same report view as Windows. Save/verify requests are retained before sending and automatically reconciled after a lost response or reload. Adding repair instructions changes only that task's follow-up draft; sending it remains an explicit action.

New-task acceptance drafts now persist in the browser session and are included in the original reliable task submission. Task templates can save these checks alongside prompt/model preferences. Applying a template replaces the new-task contract, while existing task contracts remain unchanged. Saved templates contain conditions only, without old reports or passed evidence. The template store checks its 16 MiB UTF-8 capacity before publishing a change so an oversized save cannot create a collection that fails to reopen.

Schedule edits accept an observed `revision` in their input. Updated web, Windows and Telegram clients always send the version they read; stale edits fail inside the shared storage transaction, preserving newer prompts and checks. Old schedules start at version 0, and automatic next-run/bookkeeping updates do not change the configuration revision. Legacy API callers that omit `revision` retain unconditional-save behavior for compatibility and should adopt the guard. Successful receipts capture immutable result snapshots, including the committed revision.

Each reserved schedule occurrence persists its title, prompt, workspace, worktree choice and acceptance conditions before preparing its worktree or admitting a task. A retry/restart uses this original snapshot even if the plan has since been edited; preflight authorization checks the original workspace. Plan edits apply to the next occurrence. Legacy reservations without a snapshot adopt the current plan at their first successful retry. Removing a plan abandons its unadmitted reservation without deleting worktrees or cancelling a task already created from it.

The web and Windows schedule lists expose each pending occurrence's retained snapshot. After explicit confirmation, `schedule.abandon` handles only `{ "id": "SCHEDULE_UUID", "runId": "RESERVED_RUN_UUID" }` (HTTP additionally requires `requestId`). A stale occurrence ID is rejected. If no task was admitted, only that reservation/error record is removed; files, future plan configuration, next-run time and configuration revision remain intact. If a task with that occurrence ID already exists, the operation completes bookkeeping and returns `jobId` instead of stopping or removing the task. Remote acknowledgements are recoverable through the original receipt. Results are normalized to their stored JSON representation before publication.

## Remote browser console

After forwarding the HTTP port, open `http://127.0.0.1:7899/` and enter the server's HTTP token. The console has responsive phone/desktop layouts and Chinese, English and Japanese text. It supports task creation, workflow creation, realtime task states, automatic recovery notices, paged chat, follow-up queues, pause/resume/cancel, global dispatch control, and explicit approvals/input answers. Workflow reports download through the browser after preview.

The token and unsent task draft stay in this browser session. Disconnect removes the token and displayed server state while preserving drafts, attachments and pending receipts. The session pins the server installation identity; a different installation requires a new tab so old pending requests cannot go to a replacement server. SSE reconnects automatically. Identified pending task/follow-up submissions automatically reconcile or retry with the original request ID after reconnection. Closing the browser does not stop server tasks. No model-produced HTML is executed, and a strict same-origin CSP applies.

`RELAY_CHROMIUM_PATH=/path/to/chromium node scripts/qa/remote-ui.cjs` exercises the built browser UI against the real bundled server using synthetic account-free tasks. It covers lost creation acknowledgements, initial SSE failure/reconnection, task/chat controls, workflow submission, reload and 390/900/1280px layouts. OS-specific browser and live-subscription acceptance remain separate.

Add `RELAY_QA_HTTPS=1` to run the same browser checks through a local TLS reverse proxy. This fixture requires OpenSSL and trusts its temporary self-signed certificate only inside the test browser context. It does not validate a production proxy or certificate deployment.

The browser bounds response-header waits and silent status streams to 45 seconds. Any received data, including the daemon's 15-second heartbeat comments, renews that deadline. A stalled connection reconnects with backoff and receives a fresh snapshot; it does not replay task commands. Token or installation-identity rejection remains terminal until the connection is corrected. `RELAY_CHROMIUM_PATH=/path/to/chromium node scripts/qa/stream-recovery.cjs` verifies both half-open cases through a real local proxy, using browser clock control to avoid waiting 45 seconds per case.

## Remote CLI and reliable follow-up delivery

`scripts/remote.cjs` controls the HTTP service without copying its data directory or requiring Electron. Keep a private local copy of the HTTP token and use an SSH tunnel or HTTPS endpoint:

```sh
node scripts/remote.cjs status --url http://127.0.0.1:7899 --token-file /private/http-token
node scripts/remote.cjs run --cwd /srv/project --prompt-file task.txt --detach --token-file /private/http-token
node scripts/remote.cjs send --id JOB_UUID --prompt-file followup.txt --token-file /private/http-token
node scripts/remote.cjs watch --id JOB_UUID --token-file /private/http-token
node scripts/remote.cjs workflow --file workflow.json --token-file /private/http-token
```

`run`, `send` and `workflow` print their request ID and use that same ID for bounded retries after network failures. `--request-id UUID` allows an exact retry across CLI invocations. `watch` resubscribes through interruptions, treats automatic recovery as ongoing, exits 0 only on completion, and exits 2 for paused/cancelled/manual-attention states. Other mutations are not automatically replayed. `respond --file` and `command --file` accept explicit JSON commands; `help` lists supported operations. Plain HTTP to non-loopback hosts is rejected.

Reliable `chat.submit` receipts are saved atomically with the queue or pending message. They survive restart and are checked before new delivery. Reusing an ID with different text is rejected. Receipts are not silently evicted: after 1,000 reliable sends in one conversation, create a new conversation for further reliable delivery. The browser console uses this endpoint too, retains uncertain sends, and stores follow-up drafts separately for each task.

`deploy/codex-relay.service` is an example systemd unit, not an installed service. Adjust the account, Node executable, installation path and workspace before installing it. It uses private state permissions and lets the supervisor confirm worker shutdown; if confirmation fails, systemd is configured not to force-kill the unconfirmed process tree.

## Optional Telegram control

The service also supports an explicitly enabled private-chat controller with encrypted configuration and numeric sender allowlisting. See [TELEGRAM.md](TELEGRAM.md) for setup, supported commands, replay protection and test scope. It is disabled by default.

### Diagnose an installation

With the service stopped, run `node dist/server/main.cjs --data-dir /private/data --doctor` to check the configured CLI without model calls. Exit 1 means a failed check. For a running service, use `node scripts/remote.cjs doctor --token-file /private/data/http-token` or the web settings dialog. `health` reports operational counts without task text or account identities.

### Versioned launch configuration

Copy `deploy/server.example.json` and run `node dist/server/main.cjs --config /etc/codex-relay/server.json`. Command-line options override the corresponding file value; an explicit `--workspace` list replaces the file list. Relative paths resolve against the configuration file. Unknown keys and invalid ports are rejected before opening runtime storage. Keep bot tokens in the encrypted Telegram configuration, never this launch file. `--check` and `--doctor` also accept `--config`.

### Standalone server distribution

`npm run package:server` produces `release/codex-relay-server-VERSION-source.tar.gz` with the bundled daemon/web UI, local/remote CLIs, example service/configuration, documentation and `SHA256SUMS`. Install Node.js 24, the official Codex CLI and `flock` on the target Linux host; no Electron or `npm install` is required inside this package. Extract into a versioned application directory and keep private runtime data outside it. Verify `sha256sum -c SHA256SUMS`, then run the packaged daemon with `--config` and `--doctor` before changing the service path. The package does not contain accounts or tokens.

### Connect from Windows or Linux

With Node 24 and OpenSSH installed on the client, verify the server host key using your normal SSH setup first. Then run `node scripts/remote-tunnel.cjs --host user@server` and open the printed localhost URL after SSH authentication. The helper enforces loopback binding, host-key verification, keepalives and failure on a busy forwarding port. `--check` validates without connecting. The Windows installation also ships `remote.cjs` and `remote-tunnel.cjs` in its resources folder. Closing the tunnel does not stop server tasks. Enter the HTTP token in the browser login; never put it in the URL.

### Remote browser attachments

The task and follow-up forms accept file selection, drag/drop and clipboard files (8 MiB each, ten draft attachments). Draft references survive page reloads; a pending submission keeps its attachment snapshot. Authenticated `POST /api/uploads/UUID?name=ENCODED_NAME` accepts `application/octet-stream`; `GET /api/uploads/UUID` recovers the durable receipt. Uploaded references are validated against their checksum receipt before task admission. Uploaded files reside in the owner-only service data directory and must not be exposed through a public static-file server.

### Recorded artifacts

The selected-task view lists recorded outputs and attachments, previews text/images and downloads files. The authenticated `assets.list` / `assets.read` commands use opaque revision-bound IDs; clients cannot request arbitrary file paths. Up to 100 references are inspected and each file is capped at 8 MiB. Text exports filter known credentials; binary exports preserve their original content. The Linux service validates the opened file through `/proc/self/fd` to prevent a directory/symlink swap from escaping configured roots.

隔离工作树定时任务的已记录产物也可通过网页和 Telegram 下载。每次运行持久保存原工作区路径；只有原工作区仍在当前允许范围内，且任务目录严格对应本次 worktree 预约编号、没有被软链接替换时，才读取该目录中的已记录文件。删除定时计划不会删除新运行记录的来源信息。旧运行在计划仍存在时可采用兼容来源校验。私有状态文件、其他工作树、越界链接和硬链接仍不允许下载；同一文件作为输入和产物重复出现时只列一次。

隔离定时任务同时保存来源项目标识，因此同一项目的不同 Worktree 共用项目并发上限和项目调度开关；暂停该项目调度不会中断已运行任务，但会阻止其他隔离运行继续派发。旧的、已有来源路径的运行记录在加载时补齐项目归属。

定时计划可配置每次运行的交付验收条件（文件、文本、SHA256、JSON）。网页和 Windows 使用相同编辑器；每个运行独立保存条件及报告，不沿用前次通过结论。修改、启用/暂停计划不会修改已经创建任务的条件；缺少产物时任务保持待处理，计划不叠加下一次运行。旧计划没有配置条件时维持原有行为。

### 构建与源码一致性

`npm run build` 保存构建清单，覆盖源码、构建脚本、依赖锁定文件和编译产物摘要。独立服务器打包会先核对清单；源码有变化、产物被替换/增删或没有完成构建时，需重新构建后才能打包。归档内的 `BUILD.json` 记录版本、来源摘要与服务器产物哈希；这用于追踪构建内容，不代替发行签名。

打包在私有暂存目录中复制、核对服务器产物并生成完整 tar.gz，完成后才替换发行输出。复制或 tar 失败不删除已有发行；归档发布失败会回滚发行目录。发布期间使用独占目录锁，避免两个打包进程交错替换。进程被强制结束后若残留 `.publishing` 或 `.previous-*` 目录，应先检查上次发布结果与备份，不盲目删除未知状态数据。

Read-only Git inspection is available through `project.changes` with `{ "cwd": "/configured/project" }` and `project.diff` with `{ "cwd": "/configured/project", "path": "relative/file", "staged": false }`. The Git repository root must remain inside configured workspaces; allowing a child directory does not grant access to its parent repository. Responses expose branch/HEAD and read timestamps, with bounded inventories/previews. Custom repository filters and external diff tools are disabled, submodules are not expanded, and the original index and working files remain unchanged. The Telegram `/repo` console uses these same bounded operations.

The web sidebar’s **Project Git** panel loads on request, supports an allowed working directory, filename filters and 20-entry pages, and opens staged/working differences in a read-only dialog. Large differences use bounded text pages; Copy includes the entire response. Changing the directory discards an older response, and closing a pending difference read prevents a late response reopening its dialog. Phone layouts and CSS zoom use the shared dialog’s logical viewport height to keep controls visible.
