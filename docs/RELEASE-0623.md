# v0.6.23 — Windows user-owned Telegram notifications

Complete Windows release:
[v0.6.23](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.23).
Linux-specific development remains paused. This milestone adds a complete
Windows Bot connection and notification workflow; see
[setup, behavior and evidence](TELEGRAM-WINDOWS-20261025.md).

Settings → Notifications now connects a user-owned Bot, discovers recent private
chats or accepts a manual recipient, verifies a new binding, encrypts credentials
using Windows system storage and offers explicit test messages. Completion,
acceptance failure/attention, approval/input and quota-wait events can be chosen.
Titles are private by default. Production requests follow the existing Windows
system proxy configuration, and notifications can be disabled while offline.

An encrypted durable outbox exposes outcomes, handles Telegram rate limits and
bounded API retries, isolates recipient changes, and retains history through
restart. Unknown effects require explicit confirmation before retry. A failed
disk write stops sending; an uncommitted acknowledgement never becomes a durable
success. No exactly-once claim is made. This feature does not run Telegram remote
commands or replace the separately existing Linux Telegram console.

Also replaces an old history-import test's timing delay with an actual worker
drain, so sequential imports wait for worker ownership and final writes.

Validation gates: build/typecheck, complete Windows suite, focused durable-outbox
tests, four-language production UI including 150% zoom, actual Windows Electron
system encryption/IPC/Chromium transport/scheduler/restart against a local Bot
emulator, packaged/portable startup, installer wizard and full ASAR/ZIP integrity.
No model inference or external Telegram messages are sent by these checks.
Final regression count: **584 passed, 43 platform skips, 82 files**.

Artifacts are full Windows x64 Setup, Portable and Unpacked ZIP, plus INSTALL.txt
and SHA256SUMS.txt. Complete attachments must pass download/hash verification;
there are no split volumes. Packages remain unsigned. The running installed app
and existing accounts are preserved. Real user Bot/network acceptance and the
broader Codex Desktop parity gates remain open after this release.
