# Windows recoverable workspace checkpoints — next substantial goal

Status: implemented for v0.6.28; complete Windows acceptance passed.
Linux-specific development remains paused. This milestone must include actual
capture/restore behavior, task integration, native UI and complete Windows release
acceptance; a Git plumbing helper alone is not releasable.

## Intended behavior

Capture a reviewable checkpoint before creating an isolated task branch. Preserve
the distinction between staged and working changes, intended untracked files,
raw file bytes and task/workflow provenance. Restore into a new owned worktree,
allowing inspection and explicit promotion while the original workspace remains
available. Interrupted capture/restore must have durable recovery and cancellation.

Expose the exact coverage before capture: tracked changes, untracked files and
any explicitly selected ignored setup files. Do not silently copy credentials or
run repository setup scripts merely because a worktree was created. A user's
selected file set must be complete, with progress instead of arbitrary truncation.

## Current source findings

The current implementation now includes raw file/index capture, an independently
retained Git object pack, a versioned manifest with full SHA256 readback,
transactional publication, a durable catalog and per-restore plans/layouts and
receipts. Independent restoration creates private repositories and task
worktrees; linked restoration registers a fresh worktree in the original
repository after reviewing its identity, HEAD/index/config and current raw file
selection. Both paths preserve original workspace files and index. Capture and
restore expose progress and cancellation without submitting inference.

Task Center, Workbench and Recovery Plan open the checkpoint interface. Its full
inventory is paginated rather than truncated. A restored target can become a new
paused CLI task with checkpoint/restore/manifest provenance. Captured acceptance
criteria are copied, and prior acceptance reports are not reused. Delivery and
task summaries display that provenance. Repeated restore request IDs reuse the
same durable attempt; existing or changed targets are never overwritten on retry.

Real Git tests cover separate working/staged bytes, CRLF, binary/Unicode names,
deletions, conflict stages, split indexes/shared bases, intent-to-add and
assume-unchanged flags, sparse indexes/checkouts, unborn branches, SHA-256 object
formats, initialized submodules and dirty nested repositories. Service checks
cover publication/storage failure, cancellation, restart and tampered content.
Final regression passes 696 tests with 43 platform skips across 93 files.
Actual packaged Electron acceptance passes all nine Windows flows: native
ownership, checkpoints, recovery plan, operations, CLI startup, vault, Telegram
(local emulator), delivery center and Portable startup. The Setup wizard loads
without performing an installation. Ten packaged JS/CSS bundles and the native
host match the build; all 89 unpacked ZIP files match byte for byte. Native
checkpoint acceptance covers all 159 entries and a complete 64 MiB binary,
independent/linked restores, cancellation of source inspection, paused admission,
real restart, four locales and English 150% zoom. No model inference or external
Bot messages were used.

Windows acceptance exposed two distinct platform constraints: native receipt
files exceeded MAX_PATH, and deeply nested disposable Git inspection metadata
exceeded Git's repository discovery bound. The native host now opts into modern
path handling and uses extended file paths. Git's per-command process homes and
linked-review metadata use short private temporary directories, with canonical
owner checks before cleanup. Working content remains complete in the selected
storage. The generic native domain fixture additionally exercises receipt paths
past MAX_PATH and retains the existing process ownership/recovery checks.

Restoration preserves links as links and never copies their external contents.
Missing internal link targets and external dependencies are shown in coverage.
Nonempty uninitialized submodules and unsupported Windows names fail visibly
before a complete checkpoint can be published. Repository filters/hooks/setup
commands are not copied or executed by independent restore. Linked worktrees
retain the original repository's normal shared configuration. Promotion into an
existing user workspace remains an explicit Git review/branch operation; this
feature does not automatically replace that workspace.

Desktop.createWorktree currently creates a detached checkout of a selected ref.
It does not carry the source working changes or preserve a separately reviewable
index snapshot. Existing Git controls already serialize canonical worktree roots
and guard stale branches/diffs. Reuse those boundaries instead of maintaining an
unrelated parallel Git implementation.

Desktop.git currently buffers up to 4 MiB and has a 60-second command timeout.
Those bounds may be appropriate for small UI metadata, but they cannot be used to
claim complete large-file checkpoint capture or restoration. Stream bulk content
and preserve the entire selected result. Git clean/smudge filters and line-ending
conversion mean a Git tree or patch alone does not establish exact working bytes.

Initial investigation uses an owned real Git fixture to copy the source index,
capture raw file bytes separately and restore into a new detached worktree.
The first probe passed: staged/working edits, staged/working deletions, additions
and a 4 MiB binary with a Unicode/bracket filename restore with identical raw
bytes and status. Source HEAD, branch, index bytes and status remain unchanged;
the ignored fixture setup file stays excluded. Evidence is retained under
`qa-output/workspace-checkpoint-probe-report.json`. This is not production
capture, a portable checkpoint format or proof of all index/Windows edge cases.

## Required acceptance

1. Bind capture to repository/common-dir identity, HEAD, branch, index stages and
   flags, canonical source paths and the reviewed selected file set. Detect
   changes during capture and preserve the old source/index on every failure.
2. Preserve raw selected file bytes and complete hashes independently of Git
   filters. Cover staged/unstaged edits, additions, deletions, renames, binary and
   Unicode names. Treat conflicts, sparse/index flags, symlinks/reparse points,
   submodules and external dependencies explicitly rather than silently losing
   state. Do not walk outside the selected owned boundaries.
3. Retain the Git objects and base necessary for restoration after interruption;
   a checkpoint must not rely on unpinned loose objects surviving GC. Establish
   a versioned manifest, independent storage integrity and transactional publish.
4. Restore into a fresh owned target, verify index semantics and full bytes, and
   save a durable receipt before linking a task to the restored workspace.
   Reopening or retrying must not duplicate branches or overwrite another target.
   Promotion or replacement of an existing user workspace needs a concrete
   product review action and fresh state guards.
5. Integrate task creation/branching, recovery plan, Git review and delivery
   provenance. Keep existing pause/cancel intent. Preview and restore do not
   themselves submit a model request or push changes.
6. Validate actual Git/native restart, storage failure, stale review, cancellation,
   concurrent targets, large content and four Windows locales. Then publish full
   Setup/Portable/ZIP with all attachments read back and hashed.

## Research and design inference

Official OpenAI documentation describes managed worktrees based on a chosen
commit with uncommitted changes carried across, plus snapshots used to restore
removed worktrees. It also describes explicit ignored-file inclusion and excludes
source symlinks from that inclusion. These motivate an auditable local checkpoint
with explicit coverage and exact index/byte evidence; they do not establish that
our implementation matches or exceeds the official product.
[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).

The official local-environment workflow separately configures setup scripts and
project actions. Checkpoint restoration should keep file restoration distinct
from the user's choice to run setup or a task.
[Local environments](https://learn.chatgpt.com/docs/environments/local-environment).

Git bundles retain objects/refs rather than a working directory or index;
therefore raw index and working bytes are retained separately from the object
pack. See [git-bundle](https://git-scm.com/docs/git-bundle),
[git-pack-objects](https://git-scm.com/docs/git-pack-objects) and
[git-index-pack](https://git-scm.com/docs/git-index-pack).
The native path implementation follows Microsoft's documented
[.NET path compatibility switches](https://learn.microsoft.com/dotnet/framework/configure-apps/file-schema/runtime/appcontextswitchoverrides-element)
and [extended path handling](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation).
Microsoft separately documents that a process current directory beyond MAX_PATH
can still cause [CreateProcess to fail](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setcurrentdirectory);
short private command homes address that launch constraint without truncating
saved file content.
