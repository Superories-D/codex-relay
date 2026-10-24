# Windows Telegram notifications — 0.6.23

Linux-specific development is paused at the user's request. This feature lives
in the Windows desktop main process and its notification settings. It does not
activate or modify the separately existing Linux Telegram console.

## Connect a user-owned Bot

1. Open Settings → Notifications → Telegram Bot. “Create or manage a bot” opens
   the official BotFather chat, where `/newbot` creates a Bot and issues a token.
2. Send `/start` to your Bot from your own Telegram account.
3. Enter the Bot token. Read recent chats and select your private chat, or enter
   its positive numeric Chat ID manually. Group/channel recipients are rejected.
4. Select completion, attention, approval/input and optional quota-wait events.
   Enable automatic notifications, then verify/save. The client verifies a new
   Bot/recipient with `getMe` and `getChat` before replacing the saved binding.
5. Send a test notification explicitly. The history shows queued, sending, sent,
   failed, unknown or cancelled outcomes. “Queued” is not a delivery receipt.

The connection is initially off. Enabling begins with subsequent transitions,
without replaying all historical completed tasks. An unchanged verified binding
can be disabled while offline; changing notification choices does not perform
another network verification. Disabling holds automatic notices in the queue;
re-enabling resumes them. An explicitly requested test can still send while
automatic notices are disabled. Individual queued notices can be cancelled.

Recent-chat discovery reads `getWebhookInfo` and, only when no webhook exists,
one `getUpdates` request with `timeout: 0`, `limit: 100`, **no offset**. It does not
acknowledge updates, run a command polling loop, delete webhooks or consume a
backlog by advancing an offset. A Bot with an existing webhook requires manual
Chat ID entry. Other long-poll consumers can conflict with discovery; use manual
entry or a dedicated Bot when sharing a Bot with another application. There is
no Telegram remote command execution in this Windows milestone.

## Meaningful notices and privacy

Notices distinguish completion, attention, approval/input and quota waiting.
Acceptance results for the current delivery-contract revision are included when
available. A failed delivery hold therefore generates an attention notice rather
than a false completion. Automatic process recovery is suppressed until a task
actually needs user attention. Approval deduplication uses request identity and
a digest of its parameters; no question text or answers enter the notice.

The default message contains status and a short task identifier. Task titles
require an explicit opt-in. Conversation text, file contents, workspace paths,
account credentials and approval parameters are not automatically attached.
User-supplied titles themselves can contain sensitive information. Known token
patterns are redacted, messages use plain text, previews are disabled and
`protect_content` is requested. These controls do not make Telegram a local-only
service: enabled notices are sent to the configured Telegram recipient.

The token, configuration, deduplication cursor and outbox share one atomically
written, system-encrypted `windows-telegram.enc` in the protected desktop data
directory. Tokens never appear in `telegram.read`, ordinary snapshots or receipt
errors. The password field clears after save and never receives the stored
token. On Windows, Electron safeStorage uses DPAPI; it is not isolation from
other applications running as the same Windows user. Removing the Bot explicitly
replaces the encrypted state with an empty connection and removes its history.

Production requests use Electron's Chromium network stack, including the
existing Windows system proxy configuration. The Bot API HTTPS origin is fixed;
redirects are rejected, requests have a 15-second bound and responses a 1 MiB
bound. No proxy settings or API host are changed by this feature.

## Durable delivery and its boundaries

One serialized outbox owns configuration, observations, file writes and sends.
Fast completion transitions are retained even while an API request is pending.
Each notice is persisted as `sending` **before** the external request. Success
is displayed as sent only after a valid message ID is saved to the encrypted
file. A write failure stops delivery and exposes an issue in notification
settings. The client does not continue sending on an uncommitted state.

API 429 respects `retry_after` across the entire Bot outbox and restarts. Explicit
API server errors retry with backoff, at most five attempts; permanent API
rejections remain failed. Network failure, timeout, malformed acknowledgement,
or a crash after the durable sending marker produces **unknown**, with no blind
automatic retry. The user first checks Telegram, then explicitly confirms a
retry; duplicates remain possible because Telegram sendMessage has no client
idempotency key. This is not an exactly-once guarantee. Shutdown aborts/joins
the active request and preserves its uncertainty.

Changing the token or recipient cancels unresolved records from the previous
binding. They are never redirected to a different recipient. Resolved history
is reduced to the latest 100 entries on the next enqueue, while unresolved
records remain visible. The total journal is bounded at 1,000 entries; reaching
capacity stops capture/sending with a visible issue. Resolve retained items
after restart or explicitly remove/reconnect the Bot; transitions occurring
after a stopped/full journal are not guaranteed to be recovered. These limits
apply to notification bookkeeping, not release artifacts or delivered files.

## Verification

- Build/typecheck and complete Windows regression; 17 focused outbox tests cover
  encryption boundaries, discovery, privacy, fast transitions, API rejection,
  rate limits, restart, unknown effects, recipient changes, disk failures,
  stale revisions, offline disable and shutdown. A separate redaction test covers
  tokens in URLs, diagnostic JSON and titles.
- `scripts/qa/telegram-ui.cjs`: production renderer, four Windows locales,
  light/dark layouts and 150% zoom. Parent renders/polling preserve an unsaved
  token; failed save preserves input; successful save clears it; unknown retry
  and removal require explicit confirmation.
- `scripts/qa/telegram-native.cjs`: actual Windows Electron, real system encryption,
  real IPC, real Chromium HTTP transport redirected inside the isolated QA
  process to a localhost Bot emulator, and restart. A real scheduler delivery
  hold generates a private attention notice. No external Telegram message or
  model inference is sent; this does not claim a live user Bot was tested.

Full Windows Setup, Portable, ZIP, installation instructions and SHA256 checksums
are required release gates, including readback of all complete attachments.

Primary references: [Telegram Bot API](https://core.telegram.org/bots/api),
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[Electron networking/system proxies](https://www.electronjs.org/docs/latest/api/net).
