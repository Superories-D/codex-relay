# Git review experience — 2026-10-24

The long-term goal is active: improve this project's functionality and visual
experience beyond Codex Desktop. This checkpoint improves local review; it does
not establish overall parity or completion. Existing uncommitted model-picker
work is preserved separately.

## Research and resulting behavior

Read the actual official pages on 2026-10-24:

- [Codex code review](https://learn.chatgpt.com/docs/code-review?surface=app):
  local review includes staged/unstaged scopes, line feedback and Git actions.
  Relay now supplies coordinates and surrounding source in each feedback draft,
  labels old/new versions and appends feedback without erasing existing input.
- [Remote engineering review](https://developers.openai.com/blog/mastering-codex-remote-for-engineering):
  inspect differences, control wrapping and give precise feedback within the
  conversation. Relay adds old/new gutters, text addition/deletion counts,
  previous/next hunk navigation, collapse controls and long-line wrapping.
- [VS Code staging and commits](https://code.visualstudio.com/docs/sourcecontrol/staging-commits):
  staged and working changes represent different snapshots. Relay retains its
  existing reviewed-revision/diff checks and real Git hunk operations. Display
  parsing cannot enable a patch operation that the mutation parser rejects.
- [W3C disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/):
  real disclosure buttons provide expanded state and keyboard activation.
  Navigation opens the selected hunk and moves focus to its disclosure control.

The file list can be filtered by path, with a count and explicit no-results
state. The work panel can be expanded; desktop sizing reserves room for the
composer and narrow windows use the existing overlay layout. Light-theme file
selection, context text and toolbar contrast were corrected.

Unrecognized, combined, binary and truncated diffs remain available verbatim.
Only recognized unified hunks receive source coordinates. Missing-final-newline
markers do not consume coordinates. Feedback quotes source backticks with a
longer Markdown fence, including unusually many backtick runs.

## Verification

- Build/typecheck passed.
- Full Windows suite: **534 passed, 43 platform skips**, 78 files.
- Existing real Electron / throwaway Git repository acceptance passed: mixed
  index/working views, rename, branch/worktree, commit/local-remote push, hunk
  stage/unstage, external edit refresh and stale mutation refusal. Empty account
  profiles; no inference.
- Production renderer in real Chromium: English/dark/1600, simplified
  Chinese/light/1280, Japanese/dark/900 and traditional Chinese/light/900,
  at 125% device scale. Verified filtering/no results, coordinates/counts,
  keyboard collapse/navigation, wrap/horizontal scrolling, draft preservation,
  focus, refresh, expand/narrow and absence of page/panel overflow or JS errors.
- English/Japanese translation audits: no missing keys or unlocalized literals.
- Screenshots inspected in both themes, including expanded review. The first
  synthetic harness supplied an incomplete import-status object and failed;
  the fixture was corrected. A screenshot revealed insufficient composer room
  in expanded desktop mode; panel sizing was bounded and a geometry assertion
  added. These were not hidden by removing checks.

Local evidence: `qa-output/review-full-tests.log`, `review-ui-report.json`,
`review-*.png`, `git-native-report.json`. Reproduce after `npm run build` with
`scripts/qa/review-ui.cjs` and `scripts/qa/git-native.cjs`, setting
`RELAY_PLAYWRIGHT_MODULE` and `RELAY_CHROMIUM_PATH` for the local tools.

## Remaining scope

This checkpoint does not implement selected-line staging, split diff view,
syntax/token-level highlighting, conflict resolution, PR hosting integration or
virtualization of arbitrarily large diffs. Keep these review gaps visible along
with the live account, scheduling, recovery and packaging gates in the acceptance
ledger. The installed application and release binaries are not updated by a
source commit. No production service or real account was changed for these QA
runs.
