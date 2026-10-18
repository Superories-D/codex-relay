# Git workspace correctness — 2026-10-18

Source milestone after v0.6.16; existing packages and installed client are
unchanged. All validation used throwaway repositories/profiles and zero model
requests. This is evidence for the workflows below, not complete Git parity.

## Changes

- Literal pathspecs protect single-file stage, unstage, restore and diff from
  interpreting names such as `file[1].txt` as patterns affecting other files.
- Status enumerates individual untracked files instead of collapsed directories,
  preserving Unicode paths. Shared Git status helpers distinguish index changes,
  working changes and unresolved conflicts.
- Unstaging in a repository without its first commit removes only the selected
  index entry and preserves its working file. Staged renames include both source
  and destination when diffing/unstaging; unrelated staged files remain staged.
- Restore retains staged changes, refuses untracked deletion and unresolved
  conflicts. Diff avoids external diff/text-conversion helpers.
- The panel opens the populated side of a staged-only or unstaged-only file.
  Mixed files allow switching sides; the stage/unstage action and tooltip match
  the view. Unsafe/inapplicable restore and commit buttons are disabled.
- Switching projects resets selection, commit draft and restore confirmation.
  Late responses cannot replace newer state; polls do not overlap or overwrite
  an active mutation, and periodic diff refresh retains visible content.
- Git file preview uses the returned repository root, including a conversation
  rooted in a subdirectory. It uses repository file access rather than passing
  a job ID that would force attachment resolution back to the job subdirectory.
  Ordinary chat attachment access keeps its existing ownership/path checks.
- Git status errors show their actual diagnostic instead of declaring every
  failure to be an uninitialized repository. New labels cover all UI languages.

## Evidence

- Build/typecheck passed. Full suite: **39 files / 357 tests passed** with four
  workers. Seven new real-Git cases cover unborn repositories, nested Unicode
  files, literal bracket paths, rename endpoints, mixed index/worktree contents,
  merge conflicts and two independent worktrees staging/committing concurrently.
- The first full-suite attempt ran alongside native Electron QA; three real-Git
  cases exceeded Vitest's default five seconds. These cases launch many actual
  Git processes. They now use the same bounded 20-second integration allowance
  as the existing real-Git test; no assertions were removed. The full rerun above
  passed, including a bracket-path case taking 6.45 seconds under suite load.
- `scripts/qa/git-native.cjs`: actual Electron, Japanese UI, two repositories,
  isolated empty-account profile, and a local bare Git remote. Verified staged
  rename diff/unstage; separate staged/working views; restore confirmation reset;
  untracked restore disabled; nested file preview from repo root; restore to the
  index; project selection/draft isolation; and UI stage/commit/push to the local
  remote while leaving the other repository's HEAD unchanged.
- Native QA also observes periodic refresh after an external file edit and checks
  that the visible diff is not blanked before its replacement arrives. No renderer
  errors. Screenshot inspected. Initial QA selectors were corrected to the actual
  Japanese labels, and the native test exposed the job-ID preview-root override
  that is now fixed.

Ignored evidence: `qa-output/git-native-report.json`, `qa-output/git-native-ja.png`
and the isolated `git-native-*` directories. Fixture commits/pushes affect only
the local throwaway remote; project source is committed/pushed separately after
verification. No credentials or actual user repositories were modified by QA.

## Remaining gates

Hunk/line staging, richer conflict resolution, branch management, PR workflows,
remote authentication/non-fast-forward recovery and large-diff performance remain
open. Worktree validation here proves Git index/content isolation, not safe
concurrent model edits to shared files. The broader release goal stays active.
