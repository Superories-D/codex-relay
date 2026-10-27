# Telegram mobile console (source feature)

The Linux supervisor can run an optional Telegram Bot API long-polling bridge. It is disabled unless started with `--telegram`. No bot, token or recipient is shipped or configured by this repository.

## Configure

Create a dedicated bot through Telegram's official BotFather flow and obtain your own numeric Telegram user ID. Put this configuration in a private regular file with mode 0600:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "userId": "YOUR_NUMERIC_USER_ID",
  "notify": false
}
```

Import and validate it without connecting the bot:

```sh
node dist/server/main.cjs --data-dir /var/lib/codex-relay --telegram-config /private/bot.json --check
```

The service stores the configuration encrypted with its server vault key. The input file remains yours to protect or remove; it is not automatically deleted. Enable polling explicitly:

```sh
node dist/server/main.cjs --data-dir /var/lib/codex-relay --workspace /srv/projects --http-port 7899 --telegram
```

Use a separate bot from any existing webhook integration. The bridge checks for a webhook and refuses to take it over. On first enablement (or a change of bot/user identity), old updates are discarded: send commands after the service is ready. Subsequent restarts use a persisted offset and reply outbox.

Only private messages where **both the sender ID and chat ID equal the configured user ID** are accepted. Groups, channels, bots, forwarded messages, via-bot messages and edited-message updates are ignored without replying. Usernames are never used as authorization. Bot messages pass through Telegram; the integration sends the requested command responses and, only when `notify` is true, task-transition summaries to that configured private chat.

## A complete phone workflow

Send `/start` to open the inline-button dashboard. Select a project, create a task, then send ordinary messages as follow-ups:

```text
/projects
/project 1
/new 修复登录页并验证移动端布局
增加键盘导航，并补充验证结果
```

`/run 1 instruction` remains supported. New tasks become the selected task. `/task ID` also selects a task. Project and task selections, model defaults and template contents survive service restarts. Choosing a project clears the selected task, so plain text cannot accidentally continue work in the previous project. Selecting a task does not change the selected project for future task creation.

Task cards offer **latest result, conversation, queue, pause, resume, cancel, export and diagnostics**. Pause/resume/cancel buttons open a confirmation card bound to the task's current state. Confirmation tokens expire after five minutes and become invalid after a task/queue change, use, or bridge restart. Typed `/pause`, `/resume` and `/cancel` remain direct explicit commands.

Ordinary text follows the selected task. Replying to a known task card, result page, export or notification targets that specific task without changing the selection. The last 200 successfully acknowledged task-message mappings are retained. An unknown/expired reply target fails with an explanation; it never falls back to a different task. `/forget` clears task selection.

### Tasks, results and queue

| Command | Effect |
|---|---|
| `/start`, `/home`, `/help` | Dashboard and complete command guide |
| `/projects [PAGE]`, `/project NUMBER` | Browse ten allowed workspaces per page / select a workspace |
| `/new instruction`, `/run NUMBER instruction` | Create and select an interactive CLI task |
| `/status [STATE\|all] [PAGE]` | Browse eight tasks per page; default excludes archived tasks; pinned tasks appear first |
| `/task TASK_ID` | Select a task and show state, project, model, queue and recovery details |
| `/send TASK_ID instruction` | Explicitly enqueue a follow-up without changing selection |
| `/result [TASK_ID]` | Latest recorded assistant response, paginated |
| `/history [TASK_ID]` | Paginated exported conversation |
| `/search phrase` | Search the selected conversation; show up to 30 newest matching excerpts |
| `/export [TASK_ID]` | Download a redacted Markdown conversation document |
| `/report [TASK_ID]` | Download a redacted JSON task diagnostic report |
| `/delivery [TASK_ID]` | Inspect acceptance conditions, current revision, latest file findings and recorded SHA256 evidence |
| `/verify [TASK_ID]` | Read current output files and record a new acceptance report, with a durable operation receipt |
| `/repair [TASK_ID]` | Preview a follow-up derived from failed checks; a separate confirmation submits it through normal task messaging |
| `/queue [TASK_ID]` | Queue revision, first five messages and up/down/remove buttons |
| `/queueall [TASK_ID]` | Paginated full queue text |
| `/edit MESSAGE_ID REVISION new text` | Edit a queued message in the selected task |
| `/remove MESSAGE_ID REVISION` | Remove a queued message |
| `/up MESSAGE_ID REVISION`, `/down MESSAGE_ID REVISION` | Reorder a queued message |
| `/priority high\|normal\|low` | Set selected task priority |
| `/pause [TASK_ID]`, `/resume [TASK_ID]`, `/cancel [TASK_ID]` | Control a specified or selected task |
| `/rename title`, `/pin on\|off`, `/archive on\|off` | Organize the selected task; scheduler rules prevent archiving active work |
| `/depends TASK_ID TASK_ID`, `/depends none` | Set/clear selected task dependencies with normal cycle/state validation |

Task, template, workflow and queued-message IDs accept unique prefixes of at least eight characters. Commands with `[TASK_ID]` use the selected task when omitted. Queue edits always carry a revision; old buttons or stale revisions cannot silently edit a changed queue. Queue buttons expire after five minutes, and are consumed before dispatch to avoid repeating an uncertain operation.

Result/history/search pages are **immutable snapshots**, retained for 20 minutes (up to 12 snapshots per bridge). Navigation after expiry/restart asks the user to reopen the view. This prevents a new answer from shifting text between pages. Conversation exports inherit the shared export limit of the newest 5,000 messages / 4 MiB, and explicitly mark omitted older content. Individual Telegram documents/views also have an 8 Mi-character cap with an omission notice. Markdown and JSON exports are generated documents; project output files are not uploaded automatically.

Delivery views distinguish pending checks, failed/unverified reports, old contract revisions and explicitly stale evidence. A historical pass describes files at the time of that check. Verification refuses active or unsafe-recovery tasks and does not invoke a model or shell. A pass follows the scheduler's existing delivery gate rules and can release dependent work; other pause/recovery gates remain authoritative. Lost reply checkpoints reconcile the original verification receipt without running the check again. Repair confirmation expires after five minutes and is invalidated by a task, queue or evidence change; it is consumed before sending. Confirming a repair can queue an idle task for execution, just like an ordinary explicit follow-up.

### Workflows and task defaults

Send the following as **one message** to create a dependency chain in the selected project:

```text
/workflow 登录体验改进
检查登录流程，列出问题和验证方案
---
实现修复并运行相关测试
---
检查变更，整理结果和已知限制
```

Creation is atomic and idempotent across restart/retry. Workflows contain 2–12 stages. Each later stage depends on completion of the preceding stage. These are separate tasks sharing the workspace; conversation context is not automatically copied between them. Put handoff instructions in the stage prompts when needed.

| Command | Effect |
|---|---|
| `/workflows` | Browse workflows, stage IDs and states |
| `/handoff WORKFLOW_ID` | Download a redacted handoff report with recorded responses, output references and recovery history |
| `/templates` | Browse templates saved through the web/desktop template UI |
| `/template TEMPLATE_ID`, `/template off` | Snapshot a template into Telegram's new-task defaults, or reset defaults |
| `/defaults` | Inspect current new-task defaults |
| `/model NAME`, `/model default` | Set/reset model for future tasks |
| `/effort minimal\|low\|medium\|high\|xhigh\|default` | Set reasoning effort for future tasks |
| `/plan on\|off` | Set plan mode for future tasks |

Templates prepend their saved prompt to new task/stage instructions and supply model, effort, plan and multi-agent preferences. Changing defaults never modifies an existing task. New tasks retain `on-request` approval and `workspaceWrite` sandbox policy; Telegram does not disable either.

Templates can also carry file, content, SHA256 or JSON acceptance checks. Selecting a template snapshots those checks into persistent Telegram defaults; later edits to the saved template do not change that selection. `/new`, every `/workflow` stage and `/schedule create` copy the selected checks into independent task/run contracts with empty reports. `/defaults` shows the count and `/template off` clears future defaults. Existing task conditions are unchanged. Legacy templates without checks remain readable and select an empty contract.

### Approvals and guided questions

`/approvals [PAGE]` presents one complete request at a time, including navigation to every pending request. Command and permission requests expose explicit **approve/decline** buttons. Codes expire after five minutes and bind the job, native request, history/turn identity and full current parameters. A changed request invalidates the code; opening a fresh approval list invalidates earlier codes. Requests whose full JSON detail exceeds 2,600 characters require the web console, so no approval is offered against truncated context.

Structured questions offer **逐题回答**: pick an option or send a text answer, then answer the next question. Submission happens only after all questions are answered. Option-only questions enforce the provided choices. Duplicate choices, stale question indexes, changed approvals and expired codes are rejected. `/dismiss` leaves answer mode. Answer mode is persisted so a restart cannot reinterpret an answer as an ordinary task instruction; reopen `/approvals` after restart to obtain a new code.

Advanced forms retain `/answer CODE JSON`. Elicitation requests use that explicit JSON interface. `/approve CODE` and `/decline CODE` remain available. No approval is automatic, and approvals are consumed before response dispatch rather than retried against a potentially new request.

### Service control and notifications

| Command | Effect |
|---|---|
| `/health` | Service health, task/recovery counts, dispatch state and memory summary |
| `/accounts` | Account metadata/status/quota summary, without imported authentication material |
| `/dispatch pause\|resume [project\|all]` | Hold/release new dispatch in the selected project (default) or globally; running tasks continue |
| `/limit 1..8`, `/limit auto` | Set/reset selected project's concurrency limit |

With configuration `notify: true`, completion, cancellation, manual-attention, automatic-recovery and approval transitions produce task cards. Completion cards include up to 1,200 characters of the latest assistant response found in the recent journal page, plus buttons for the full result. The 500 most recently updated tasks are tracked. Pending notification bursts are sent five per poll; excess notifications remain pending for later polls. Each successful notification is checkpointed separately. Recovery notifications describe automatic continuation; they never override manual pause/cancel intent.

## Delivery and security boundaries

Both normal messages and inline-button callbacks require the configured private chat and sender IDs. Callback acknowledgement failure does not prevent an otherwise valid operation. Edited messages, groups, other senders, forwards and via-bot messages remain excluded. Slash commands addressed with an `@BotName` suffix are accepted only after those same ID checks.

Before any operation, the bridge persists the resolved command and a snapshot of its project, task and defaults. Task creation, workflow creation and follow-ups derive deterministic request IDs from bot identity plus Telegram update ID and use the scheduler's durable deduplication receipts. A failed disk checkpoint or lost reply cannot redirect a follow-up to a newly selected task, create another workflow or enqueue the same instruction twice.

The complete reply, keyboard and any generated document are persisted before sending. Lost acknowledgements can repeat a Telegram reply/document, but do not repeat creation or message admission. Other explicit state-setting commands may be retried; queue revisions and one-use approval/control tokens reject stale or uncertain repeats. Notifications are also at-least-once around a lost send acknowledgement. Restart expires ephemeral action/approval/page tokens while retaining selections, admission snapshots, the outbox and message-to-task routes.

Text is plain text, known credential patterns and the exact configured bot token are redacted before pagination/upload, sends are paced and Telegram retry delays are honored. The integration has no arbitrary runtime-RPC or shell-command endpoint. Arbitrary project-file download, voice transcription, account-token import and server lifecycle operations are not implemented; unsupported incoming media gets an explanatory response instead of being silently dropped. Task instructions can still ask Codex to work within its configured project, approval and sandbox policy.

Implementation references: [getUpdates](https://core.telegram.org/bots/api#getupdates), [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton), [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery), [sendDocument](https://core.telegram.org/bots/api#senddocument).

## Validation

`tests/telegram.test.ts` exercises the real local server store/scheduler with an injected Telegram transport. Coverage includes encrypted configuration; sender/chat and callback authorization; backlog handling; persistent selections/defaults; reply routing; task/workflow/message deduplication; failures before and after admission; immutable long-result pagination; multipart document upload; redacted document outbox replay; queue revisions; dependency chains; template use; project dispatch; approval expiry/mutation; guided questions; unsupported media; and notification bursts across restarts.

These tests do not send real Telegram messages or call a model. Live bot delivery and live model execution still require operator acceptance with their own bot configuration. The bridge runs in the Linux supervisor; Telegram clients on Windows and mobile use the same bot, while the native Windows desktop app does not host this bridge.

The dated implementation and acceptance record is available in [Telegram console verification](TELEGRAM-CONSOLE-20261023.md).

## Incoming files (iteration 1)

Send a document or photo to stage it durably (8 MiB per file, up to 10 pending files). `/inbox` lists staged files; `/inbox clear` clears the selection without deleting files already referenced by tasks. The next `/new`, `/run` or task follow-up includes that attachment snapshot. Captions do not execute instructions automatically. Files are downloaded only from Telegram's official file endpoint with streaming size limits, saved under an opaque upload ID with checksum receipts, and reused across lost replies/restarts. Workflows require an empty inbox; attach files to individual stages instead.

A `getFile` rejection with HTTP 400, 413 or 422 produces a retained error reply asking the user to resend the attachment, then permits later updates to proceed. Network failures, authentication/permission errors, 404, rate limits and service failures retain the original incoming attachment for retry; they are not silently discarded. API errors expose only the method and HTTP status, without reflecting the remote error description or token. Download interruptions continue to use the existing durable retry path.

## Recorded output downloads (iteration 3)

`/files [TASK_ID] [PAGE]` lists recorded output/input files, with 20 download buttons per page and up to 100 references inspected. Links expire after ten minutes or restart. Downloads recheck the current file revision and the opened descriptor's real path; missing, changed, oversized, multiply-linked or out-of-root files are rejected. Text is filtered for known credentials; binary downloads preserve bytes. Each file is limited to 8 MiB. This is a recorded-artifact browser, not an arbitrary server filesystem endpoint.

### 通知控制台

`/notify all|errors|watched|off` 选择全部、仅异常/审批/自动恢复、仅关注任务或关闭；`/watch [任务ID]` 关注当前/指定任务并进入 watched 模式，`/unwatch ID` 取消关注。`/quiet 22-7` 设置跨午夜静默窗口，小时均为 **UTC**；`/quiet off` 关闭，起止相同表示全天静默。`/throttle 60` 设置通知发送间隔（0–3600 秒）。`/digest` 查看模式和排队摘要。

每次轮询捕获到的变化先保存不可变通知内容，静默期间继续排队，重启后恢复发送；每轮最多 5 条，最多保留最近 200 条，溢出数量在摘要中显示。关闭通知会清空待发内容；切换过滤模式会剔除不匹配的通知。发送回执丢失可能导致单条重复（at-least-once），不会因此重跑任务。轮询之间已经发生又消失的瞬态状态不保证捕获。

### 文件、实时控制、Goal 与自动化

| 操作 | 命令 / 交互 |
| --- | --- |
| 上传任务文件 | 发送照片或文档，`/inbox` 检查，下一条 `/new` 或追问附带文件；字幕不自动执行 |
| 下载已记录结果 | `/files [任务ID] [页码]`，点文件按钮；单文件最多 8 MiB |
| 立即干预运行 | `/steer 补充指令`，作用于当前选中且正在运行的任务 |
| 模型等待恢复 | `/models` 查看缓存；`/switchmodel MODEL [EFFORT]` 切换并恢复模型等待任务 |
| 持续目标 | `/goal read`；`/goal create 20000 目标` 创建暂停目标；`/goal start`、`pause`、`clear` |
| 修改目标/预算 | `/goal edit 新目标`；`/goal budget 40000` 或 `none`；编辑正文会重置原生累计统计，预算仍按原生轮次核算 |
| 定时任务 | `/schedules`；`/schedule create 60 每小时检查项目`；`/schedule run|pause|enable|remove ID` |
| 工作流批量控制 | `/wf pause WORKFLOW_ID`、`/wf resume WORKFLOW_ID` |
| 从阶段返工 | `/wf preview WORKFLOW_ID STAGE`，审阅后 `/wf retry PREVIEW_ID`；分支默认暂停，原历史保留 |

实时控制、Goal、定时和工作流操作在服务器先记意图，再执行。普通网络中断按同一请求编号确认；原生调用结果无法确定时返回未知状态，避免双重执行。修改 Goal 正文、立即执行定时任务和启动目标均需用户明确发出对应命令。工作流返工预览有效期十分钟。

### 远程操作记录

`/actions` 查看最近 20 条有持久回执的远程操作，`/receipt UUID` 查看原回执。网页侧栏“远程操作记录”提供分页、刷新、回执详情及任务跳转。列表只返回操作摘要，不包含原参数、结果正文或请求指纹；损坏记录显示为不可读取。pending/uncertain 表示需要核查原任务，不会提供自动重放原生调用的按钮。
