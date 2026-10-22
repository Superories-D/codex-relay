# Telegram private-chat control (source feature)

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

## Commands

| Command | Effect |
|---|---|
| `/projects` | List configured workspace numbers |
| `/status` | List recent task IDs and states |
| `/run 1 instruction` | Create a task in workspace 1 |
| `/send TASK_ID instruction` | Reliably enqueue a follow-up |
| `/pause TASK_ID` | Pause one task |
| `/resume TASK_ID` | Resume a paused/attention task |
| `/cancel TASK_ID` | Cancel one task |
| `/approvals` | Show current requests and short-lived confirmation codes |
| `/approve CODE` | Explicitly accept the displayed command/permission request |
| `/decline CODE` | Explicitly decline it |
| `/answer CODE JSON` | Send an explicit input/elicitation response object |
| `/help` | Show command usage |

Task IDs may be an unambiguous prefix of at least 8 characters. Approval codes expire after five minutes and are bound to the job, native request, history/turn identity and full current parameters. Changing the request invalidates the code. Requesting a fresh approval list invalidates the previous codes. Large requests require the web console instead of approving from truncated context. No approval is automatic. Input answers use the same validated JSON structure as the desktop/HTTP interface.

Creation and follow-up IDs are derived deterministically from bot identity and Telegram update ID, connecting to the scheduler's durable deduplication receipts. A disk failure after admission or a Telegram reply failure does not create another task or deliver the same queued instruction again. Replies are saved in an outbox before sending. Telegram reply delivery itself is at-least-once: a lost acknowledgement can cause a repeated reply, but not repeated task creation. Optional notifications summarize recent task transitions; they do not upload conversation transcripts or files.

The official API's offset acknowledgement and message-length rules informed the implementation: [getUpdates](https://core.telegram.org/bots/api#getupdates), [sendMessage](https://core.telegram.org/bots/api#sendmessage). Outgoing text is bounded and plain text, known credential patterns are redacted, same-chat sends are paced, and server-provided retry delays are honored.

## Validation

`tests/telegram.test.ts` uses an injected synthetic Telegram transport. It tests encrypted configuration, backlog handling, sender/chat authorization, restart deduplication, reply-outbox recovery, checkpoint failure after task admission, approval mutation/expiry and notification persistence. No real Telegram message is sent by these tests. Live bot delivery, platform rate limits and live model execution still need acceptance testing with the operator's own configuration.
