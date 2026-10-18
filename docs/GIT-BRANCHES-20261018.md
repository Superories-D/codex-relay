# Git branch management — 2026-10-18

The Changes panel now offers a searchable branch picker beside the current
branch. It switches local branches, creates branches from the current revision
or a selected branch, and creates explicitly tracked local branches from remote
refs. Names and repository content remain untranslated. UI labels and actionable
errors support Simplified/Traditional Chinese, English and Japanese.

The catalog uses exact full refs, omits symbolic remote HEAD aliases and records
which branches are checked out in other worktrees. Occupied branches cannot be
switched to; they can still be a starting point for a different new branch.
Git remains authoritative and rejects overwriting dirty content or switching a
branch held by another worktree. There is no force, reset, automatic stash, fetch
or branch deletion in this flow. `switch -c` does not leave a branch behind if
checkout fails. Remote refs create explicit upstream tracking.

Branch changes in the same worktree are serialized. The request includes the
observed current branch and commit; a stale request is rejected before mutation.
External Git processes remain outside this application's serialization. The
native Git index/ref locks and checkout protections still apply.

Errors retain the branch-name draft for correction and refresh the catalog.
Successful switching clears obsolete diff/restore selection. The picker is
unmounted when changing projects, preventing draft and result leakage.

Evidence:

- Four real-Git integration cases cover unborn repositories, detached HEAD,
  Unicode branch names, staged/working content preservation, rejected dirty
  checkout, transactional creation failure, remote tracking/aliases, worktree
  occupancy, invalid/missing refs, stale commits and simultaneous requests.
- Full build and suite passed: 43 files, 384 tests. Four-language catalog audit
  passed. Subsequent visual-only adjustments are checked in the packaged app.
- `scripts/qa/git-native.cjs` exercises Japanese UI selection, invalid-name
  correction, Unicode creation, local switching, remote tracking, occupied
  worktree disabling and search alongside existing real Git file/commit/push
  workflows. It uses throwaway repositories and a local bare remote.

No real accounts or inference requests. Hunk staging, advanced conflict handling,
branch deletion/renaming, PRs and remote authentication recovery remain separate
release-readiness gaps.
