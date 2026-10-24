# v0.6.21 — searchable CLI model catalog

Windows x64 release: [v0.6.21](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.21).
Distribution includes complete Setup, Portable and unpacked ZIP files, installation
instructions and SHA256 checksums. Full-size artifacts are uploaded directly to
the user's LAN Gitea endpoint and verified by downloading them again.

The model list adds search by display name, model ID and catalog ID. Search accepts
multiple terms, ignores case and normalizes full-width characters. Hidden entries
stay hidden unless already selected. The localized default option can also be
searched and selected; no match shows an explicit empty state.

Opening the list focuses search. Arrow keys move to results, and Enter selects
only a single unambiguous filtered result. Clearing restores focus; leaving the
list clears its filter. IME composition Enter and Escape preserve the picker.
The text field filters a group of real buttons; it does not claim combobox
semantics or commit arbitrary typed model names. The
[W3C combobox guidance](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
informed the distinction between exploring choices and committing a selection.

Validation: production renderer, seven existing workspace layout/theme/language
combinations and four large-catalog layouts (72 visible choices at 150% scale),
delayed catalog/failure/account-switch recovery, plus 11 model/access/responsiveness
tests. The previous core checkpoint is v0.6.20's full 546 passed / 43 platform
skips. This UI-only milestone does not rerun unrelated core suites. Build/typecheck
and packaged/portable startup, installer wizard, ASAR/ZIP integrity and attachment
readback remain release acceptance checks. No inference is used.

The running installed app and existing profiles are preserved. Publisher signing,
Linux native installation and the broader real-account acceptance gates remain
open; iteration continues.
