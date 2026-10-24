# Codex Relay 0.6.28 — Windows workspace checkpoints

Capture the complete selected working files, original Git index and independent
Git objects before branching a task. Review every file in a paginated inventory,
including hashes, deletion state, ignored-file choices and external dependencies.
Raw bytes are retained independently of line-ending conversion and repository
filters. The source working directory and index remain available unchanged.

Restore into a fresh independent workspace even after losing the source
repository, or review the original repository and register a new linked worktree
and branch. Restores verify full content and index semantics and write a durable
receipt. Retrying a restore request reuses its recorded attempt. Interrupted or
modified targets remain intact for inspection.

Create a new **paused CLI task** from a verified restore. The task carries its
checkpoint, target, branch and manifest identity. Captured acceptance criteria
are copied and must pass again; previous reports are not reused. The source
task's pause/cancel intent stays intact. Preview and restore do not submit model
requests, push changes or run repository setup commands.

Open **Task center → Workspace checkpoints**, the checkpoint button in the
workbench, or **Recovery plan → Review workspace checkpoints**. Task and delivery
summaries show the checkpoint provenance. Four interface languages and Windows
zoom are supported.

Real repository coverage includes partially staged changes, CRLF/raw binary and
Unicode paths, conflicts, resolve-undo evidence, split indexes/shared bases,
intent-to-add/assume-unchanged flags, sparse checkout, initialized submodules,
dirty nested repositories, unborn branches and SHA-256 repositories. Native
acceptance exercises all bytes of a 64 MiB file, all 159 inventory entries,
independent/linked restoration, paused admission and actual app restart. Storage
failure, stale review, cancellation and tampered evidence are checked separately.

The Windows process host now handles long receipt paths. Short private command
homes and disposable metadata keep Windows/Git launch constraints separate from
the complete saved content. Existing process ownership and recovery checks remain.

Validation: 696 tests passed with 43 platform skips across 93 files. All nine
packaged Windows acceptance flows and the Setup wizard check pass. Ten packaged
code/style bundles and the native helper match the build; all 89 files in the
complete unpacked ZIP match byte for byte. Four native checkpoint locales and
English 150% zoom pass without model inference or external Bot messages.

Full distribution includes Setup EXE, Portable EXE, unpacked ZIP, INSTALL.txt and
SHA256SUMS.txt. No split archives or arbitrary content size reduction. Windows
10+ is required; packages are unsigned. Automatic CLI detection/installation,
Telegram Bot notifications, delivery tools and the independent vault remain
included. Linux-specific development remains paused. See
[behavior and limits](WORKSPACE-CHECKPOINTS-20261025.md).
