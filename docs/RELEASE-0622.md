# v0.6.22 — Windows verifiable delivery

Complete Windows x64 release:
[v0.6.22](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.22).
This is a functional milestone covering the acceptance contract, execution gate,
file evidence, task dependencies, restart, repair drafts and workflow reports.
It also includes the large-diff review work described below. Linux-specific
development is paused; this release does not introduce a Linux adapter or bundle.

Configure checks before sending a task, or through the conversation menu when
idle. The client verifies actual files after worker shutdown. File existence and
size, text literals, full SHA256 and typed JSON Pointer checks are supported.
Failed/unverifiable results hold dependent tasks and keep queued follow-ups.
Inspect/export evidence, repair files and explicitly recheck, or append repair
instructions to the current draft. No repair message is sent automatically.
[Usage, boundaries and evidence](DELIVERY-ACCEPTANCE-20261025.md).

Large diffs now initially open the first hunk, release folded row DOM and page
individual hunks at 400 display rows with direct page selection. Complete source
remains available across pages. Line feedback preserves original coordinates,
and staging always submits the complete hunk. The measured 20,080-row fixture
previously kept all 20,080 nodes when folded and took about 3.1 seconds on this
machine; the new fixture initially renders 251 rows, none while fully folded,
and measured roughly 0.4–0.5 seconds. These are local observations, not general
hardware performance guarantees. A 10,001-row single hunk was reviewed through
its final source line and staged with the complete expected diff.

Validation includes full Windows regression and build/typecheck, real local file
checks and scheduler integration, real Electron file verification/download/restart,
four-language production UI and large-diff interactions. All checks are
account-free and send zero inference. Packaged and Portable startup, installer
wizard, ASAR/ZIP integrity and complete attachment readback are release gates.
Final counts and distribution hashes accompany the release.

Source checkpoint: **81 test files, 566 passed / 43 platform skips**. Windows
production-renderer checks cover four locales; native Electron verification
checks four real predicates, actual evidence download, three missing-artifact
failures, repair-draft preservation and restart with two retained reports.

Assets: complete Setup EXE, Portable EXE, unpacked ZIP, `INSTALL.txt` and
`SHA256SUMS.txt`. No binary splitting or reduced package contents. Existing running
installation and user accounts stay intact during QA. Publisher signing and
broader real-account acceptance remain open. Iteration continues with Windows
Telegram Bot notifications; see [active roadmap](ITERATION-ROADMAP-20261024.md).
