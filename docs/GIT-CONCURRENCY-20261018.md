# Git operations across concurrent conversations — 2026-10-18

Source milestone after the v0.6.17 release. No installation, repackaging or model
requests; existing release binaries and tag remain unchanged.

## Problem and resulting behavior

Previously only branch switches shared a queue. A stage request could read its
target, wait, then run after another conversation had already switched branches.
Two commits could compete for `index.lock`. A stale UI could also commit a newly
replaced staged blob even though the visible porcelain status still said `M`.

- Status/diff reads, stage/unstage/restore/commit/push, branch controls and Worktree
  creation now share a queue for each canonical working directory. Nested project
  directories and Windows junction aliases resolve to the same queue. Independent
  linked Worktrees keep their own queues and can continue while another is busy.
- Changes carry a revision derived from branch identity, commit, full staged blob
  IDs/modes and status. The IPC mutation endpoint requires the reviewed revision;
  it is checked after admission to the queue. A failed/rejected request does not
  prevent later operations from proceeding.
- File mutations also require the displayed diff and compare it immediately
  before invoking Git. Changed working text is rejected even when status and
  index are unchanged. No force/reset/autostash or lock-file deletion was added.
- The UI waits for the selected diff, retains the commit draft on rejection and
  cancels obsolete restore confirmations. Refresh/reselection reloads the diff
  for review and retry. Actionable errors appear locally, without a duplicate
  global banner. English and Japanese messages are translated; Traditional
  Chinese continues through the existing conversion.

## Evidence

`tests/git-concurrency.test.ts` uses actual temporary Git repositories, indices
and Worktrees. An execution gate controls timing of one real `git add`; Git
results/content are not mocked. Before the fix, four cases failed: switch ran
before the held stage, an unseen staged blob was committed, an old-branch restore
discarded working text, and two commits hit a raw `index.lock` failure.

After the fix, five cases pass, covering alias/nested-path serialization with an
independent Worktree making progress, stale index and branch rejection, concurrent
commit admission, queue recovery, and preserving working text changed since its
preview. The complete suite passed **44 files / 389 tests** with four workers.
Build/typecheck passed. No test timeout was increased.

`scripts/qa/git-native.cjs` runs real Electron with Japanese UI, an empty-account
profile, two temporary repositories and a local bare remote. It verifies existing
file/rename/branch flows, rejects a stale UI commit without changing HEAD, retains
the draft, refreshes/reviews/commits successfully, and rejects stale restore while
preserving the newer file. It also checks IPC requests cannot omit revision/diff
guards, error locality, and retry by reselecting the current file. No renderer
errors or inference requests. Final UI adjustments were rebuilt and rechecked in
this native run after the full suite passed.

Ignored evidence: `qa-output/git-concurrency-tests.log`,
`qa-output/git-concurrency-native.log`, `qa-output/git-native-report.json`,
`qa-output/git-concurrency-native-ja.png` and the isolated `git-native-*` fixture.

## Scope and remaining gates

This serializes the application's managed Git operations in one process. It does
not lock arbitrary editor/CLI/model writes across the entire filesystem. Git's
own locks still arbitrate external Git processes, and external changes can occur
between validation and command execution. Text-diff comparison is not a binary
content snapshot: Git's generic binary diff notices do not identify every content
change. Use independent Worktrees to isolate simultaneous editing tasks; this
milestone does not establish safe unrestricted model edits in one shared folder.

Hunk/line staging, richer conflict resolution, remote error recovery, PR workflows
and large-diff performance remain open, as do the broader live-account gates in
`RELEASE-READINESS.md`.
