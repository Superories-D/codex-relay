# Codex Relay 0.6.27 — Windows recovery isolation

Verified managed Windows CLI recovery can now reserve only its affected project,
session family and account. Independent tasks can continue on another eligible
account and project while related work waits. Unknown ownership, older markers,
existing/native permissions, Desktop and full-access contexts retain global
recovery checks.

The bundled native process host assigns the CLI to a kill-on-close Windows job
at creation. Durable nonce and process-creation identities support actual tree
cleanup, crash recovery and replacement-safe release. Runtime junction aliases
use the same canonical owner. No external compiler is needed on the client.

Open **Task center → Task operations → View recovery plan** for affected tasks,
reserved resources, process counts and preserved stop intent. Recheck reads
ownership and saves evidence without submitting model work or stopping processes.
Stale plans refresh clearly. Missing or unsaved evidence keeps the global hold.

Four native languages and Windows zoom are supported. Full current-source checks:
672 passed, 43 platform skips. Actual native ownership, scheduler, restart,
persistence failure and recovery UI checks run without model inference.

Full delivery includes complete Setup EXE, Portable EXE, unpacked ZIP, INSTALL.txt
and SHA256SUMS.txt. Windows 10+ is required for the native creation API. Windows
packages are unsigned. Linux-specific development remains paused. CLI automatic
installation, Telegram Bot notifications, delivery center and ZIP64 vault remain
included. See [behavior and limits](RECOVERY-DOMAINS-20261025.md).
