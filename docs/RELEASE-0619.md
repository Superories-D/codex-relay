# v0.6.19 — CLI bootstrap and Git review

Published: [complete Windows x64 release](https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.19), source `778e5ef`.

Startup detects and verifies an existing Codex CLI, installs the official pinned
CLI when none works, and gates dispatch until ready. The renderer stays usable
and shows preparation, errors and retry. See [bootstrap evidence](CLI-BOOTSTRAP-20261024.md).
Git review adds accurate old/new line numbers, counts, hunk navigation/collapse,
wrapping, filtering and a wider panel. Contextual feedback appends to existing
drafts. See [review evidence](REVIEW-EXPERIENCE-20261024.md).

All attachments are complete files. Uploads use the user-provided LAN Gitea
endpoint; no proxy limit workaround by splitting files, disabling size checks or
changing server configuration was needed. All five attachments were downloaded
again and SHA256-verified; the public anonymous installer download also matches.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Setup EXE | 126175581 | `1266cbba53a3cd4f86d399e24539f2d5dc878b6841c39caac6aa520a7586aead` |
| Portable EXE | 125945770 | `8b3833d1cf88a3d64eeda5adea7c1073f13cddbbc806d21bb58f75681b203173` |
| Complete unpacked ZIP | 169653579 | `c17385c6737701561e1207f625297820852f390c4b2190ecb9dc07badfb12723` |

`INSTALL.txt` and `SHA256SUMS.txt` are also attached. Local output is
`release/desktop-0.6.19`.

Validation: clean source build; 80 test files, 546 passed / 43 platform skips;
actual official CLI installation and repeated detection; two packaged Electron
launches; actual portable extraction/start/exit; four languages and both themes;
real Git operations in disposable repositories. The NSIS upgrade wizard was
opened without proceeding with installation. All 86 ZIP files match the unpacked
directory, and nine bundled JS/CSS files match the clean build byte for byte.
One preexisting warmup recovery test now joins asynchronous cleanup before
requesting recovery, matching the public lifecycle contract rather than racing
an intermediate status write.

No model inference was sent. The running installed application and user profile
were preserved. Publisher signing, Linux native bootstrap acceptance and the
other open [readiness gates](RELEASE-READINESS.md) remain outstanding.
