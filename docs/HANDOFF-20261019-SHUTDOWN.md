# Shutdown handoff — 2026-10-19

Read this together with `RELEASE-READINESS.md`. The original comprehensive local
handoff is `D:\DMH_Files\Python_projects\codex-relay\handoff-20261018\HANDOFF-ALL.md`;
from this repository its path is `../handoff-20261018/HANDOFF-ALL.md`.

## User instruction and stop condition

The user allowed 160 minutes from 2026-10-18 23:32:38 Asia/Shanghai and instructed
stopping if unfinished before the machine shuts down. Deadline: **2026-10-19
02:12:38 local / 2026-10-18 18:12:38 UTC**; reserve the final five minutes for
cleanup and handoff. The full release-readiness goal remains unachieved. Stop
under this user instruction and leave the goal paused; do not resume it without
a new user instruction. Do not treat the published release as goal completion.

## Completed delivery — do not repeat

`v0.6.17` is already published at
https://code.taiko.im/Superories/codex-go/releases/tag/v0.6.17
(release ID 1, `draft=false`). Its immutable tag is application commit
`9523a8926e01e88c16ff3a59248d9d2fce2624e8`.

The user-provided alternative origin is **HTTP** `http://192.168.1.124:8443`.
It served the same Gitea repository and successfully accepted the existing binary
volumes after public-domain uploads had failed. All six release attachments were
downloaded through both the origin and public HTTPS domain, with matching hashes.
Four binary volumes plus `INSTALL.txt` and `SHA256SUMS.txt` exist without duplicates.
No additional release, retag or rebuild is needed to repeat that delivery.
See `RELEASE-0617.md` and ignored `qa-output/release-public-verify-0617.log`.

Local full installer and ZIP remain under `release/desktop-0.6.17/`. The user
installs updates themselves. The source fixes listed below are **newer than those
binaries**, and have not been repackaged or installed. Package version still
reads 0.6.17; do not infer binary inclusion from that version string.

## Subsequent source milestones

All milestones are on `main`; verified nodes were committed and pushed.

| Commit | Change | Evidence |
| --- | --- | --- |
| `16e0f1e` | Serialize managed Git operations per canonical Worktree; reject stale revision/index/file previews | `GIT-CONCURRENCY-20261018.md` |
| `94916a7` | Stage/unstage individual text hunks without changing working files; reject stale or unsupported patches | `GIT-HUNKS-20261018.md` |
| `60456e7` | Separate latest CLI context snapshot from cumulative thread usage; legacy records show current usage unavailable | `TOKEN-USAGE-20261018.md` |
| `31a8dcb` | DST-safe recurrence, persisted system-zone projection, immediate wake admission | `SCHEDULE-CLOCK-20261019.md` |
| `7b4e71c` | Publish schedule create/edit/delete only after durable writes; preserve retry state | `SCHEDULE-STORAGE-20261019.md` |
| `4e18b98` | Mask complete authentication diagnostics and URL user information, preserve parseable JSON | `DIAGNOSTIC-REDACTION-20261019.md` |
| `35d82ed` | Strict UTF-8 preview/write protection; explicit external-editor guidance for unsupported bytes | `FILE-ENCODING-20261019.md` |

Final verified code revision: `35d82ed`. Full suite: **48 files / 419 tests**,
passed at 02:03 local time, log `qa-output/file-encoding-tests-final.log`.
Build/typecheck and actual Chinese/Japanese file-editor validation passed.
The translation audit found 970 static UI keys, zero missing English/Japanese
translations and zero unlocalized static text. Earlier test counts in milestone
documents are historical checkpoints. Later commits only record this handoff.

The interrupted earlier full run had no completion summary, no surviving process
handle and no matching process; it was rerun once to obtain the final passing
result. Final process inspection found no matching `vitest` or QA node/Electron
processes. Existing installed client processes are outside QA cleanup scope.

## Evidence boundaries and outstanding requirements

- Real CLI execution, existing parent/child workflows and one real same-thread
  automatic account relay have prior live evidence. The most recent original
  live task's business/code output remains unaccepted. Its completion state does
  not establish correctness; see original handoff section 11.
- Concurrent independent tasks, refresh coalescing, deep-agent recovery and
  interrupted-process cleanup have deterministic local subprocess coverage.
  Real-account concurrent inference/refresh/relay, deep hierarchy and Goal
  combinations still need separate bounded acceptance. Do not launch quota tests
  merely because a goal exists.
- Complete reset-cycle observation followed by automatic `hi` remains unverified.
  Prior standalone `hi` and synthetic reset tests are different evidence.
- Calendar and time-zone cases use actual Node calculations and saved files.
  Electron resume notifications were emitted into the real listener; physical
  OS suspend, provider connection recovery and scheduled output correctness were
  not tested.
- Local CLI/Electron MCP/OAuth fixtures passed. Remote marketplace and provider
  OAuth/refresh, model-driven tools and subagent plugin combinations remain open.
- 632 imported histories lack source/ancestors and remain explicitly read-only.
  Do not invent resumable context or modify original history databases.
- Git selected-line staging, advanced conflicts/PR operations, remote-error
  recovery and unrestricted external filesystem races remain open. Text hunk
  staging excludes unsupported metadata/binary/undecodable patches.
- Arbitrary legacy-encoding inline editing is unsupported; the new guard prevents
  silent conversion and preserves external-editor access. Large file/diff bounds
  and broad performance/real-content acceptance remain.
- Publisher signing remains open. New source milestones require a separately
  authorized packaging/installation decision; existing release delivery is done.

## Operational constraints

Actual installed application: `D:\codex-relay\Codex Relay\Codex Relay.exe`.
MSIX AppData has two views: inspect the actual installed profile only through the
Explorer Desktop Shell helper documented in the original handoff. Do not infer
the actual profile by directly reading a tool-visible AppData path.

Credentials remain encrypted; none were printed, committed or overwritten by
these milestones. Never restore old conversation tokens over current credentials.
This run used temporary empty-account profiles or synthetic local protocol peers;
no new quota-consuming model test was run. The installed client was not restarted.

On resumption, check Git status/log and the final verification note before taking
action. Do not repeat prior pushes, release publication, binary uploads or native
installation. All temporary native QA applications should already be closed;
inspect process state before restarting any interrupted validation.
