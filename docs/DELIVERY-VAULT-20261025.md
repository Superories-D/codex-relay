# Windows delivery vault — v0.6.25

The delivery center previously preserved acceptance evidence while the actual
artifact bytes remained in the working directory. A later edit or deleted
workspace could therefore leave a useful report without deliverable files.
The Windows delivery vault stores independent, versioned copies of accepted
artifact files and can export a complete, offline handoff archive.

## User workflow

1. Open Task center → Delivery center. Configure and pass artifact acceptance.
2. Select idle, accepted tasks and choose Save delivery version. Review the
   version name, complete file count, byte total, task states and free disk space.
3. Save complete version. The application reads every source byte, checks the
   accepted SHA256 and size, writes an independent copy, flushes it, and rereads
   the stored file. It also rechecks the frozen contract and task state before
   publication. No model is started; a user's pause/cancel intent is preserved.
4. Open Delivery vault to inspect manifests, verify complete versions, recover
   interrupted publication, open their folders, export or explicitly delete them.
   Changing storage preserves versions in previous locations.
5. Export complete delivery archive writes a full ZIP/ZIP64 file, including all
   artifacts, manifest.json, index.html, Verify.ps1, Verify.cmd and SHA256SUMS.txt.
   Open index.html offline; run Verify.cmd on Windows to check artifact bytes.
   For an externally trusted manifest fingerprint, use:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Verify.ps1 -ExpectedManifestSha256 <fingerprint>
   ```

## Integrity and recovery

- SHA256 covers complete files; size limits do not truncate or split artifacts.
  Read loops use bounded buffers and reject files growing beyond their accepted
  length. Acceptance has no fixed two-minute deadline; owner cancellation remains
  available between reads. Storage/filesystem limits and available capacity apply.
- The vault is independent of the workspace. It does not use hard links. Task
  titles, project basenames, acceptance criteria, states and workflow provenance
  are retained; account credentials, prompts and absolute source workspace paths
  are excluded from the public manifest. Criteria and artifact names are included
  as the user reviewed them and may themselves contain private information.
- Canonical path and owner markers constrain storage, staging, publication and
  deletion. Each version has a unique identity. The catalog is written atomically;
  Windows sharing-like write failures have bounded retries. Genuine disk errors
  do not invalidate source acceptance or turn partial writes into ready versions.
- A durable sealing checkpoint precedes directory publication. Interrupted saved
  versions can be fully rehashed and recovered without the original task or
  workspace. Unfinished deletion is recorded and can be explicitly completed.
- Export uses an explicit trusted file list, not a directory scan. Every source
  entry is rehashed during packing; the archive is then reopened, every entry is
  decompressed and fully rehashed, and the complete ZIP is hashed again before
  replacing the selected destination. Existing files remain on pre-publication
  failure or cancellation. Destination changes during packing stop publication.
- Durable export attempts record temporary file identities as exact decimal
  strings using bigint filesystem stats, including Windows file IDs above the
  JavaScript safe-integer range. After a crash, Check interrupted export fully
  verifies a possibly published ZIP before restoring its receipt. It removes
  only owned temporary files after checking path, generated name and file ID.
  Replaced or unverifiable files are preserved for manual inspection. No export
  is blindly replayed. An unconfirmed attempt needs a new explicit export.
- App verification checks all five metadata files and all artifacts against the
  private catalog. The standalone verifier checks the manifest and artifact
  files; it is not a code signature, and a manifest without an externally trusted
  fingerprint does not authenticate the author. This is neither a same-user
  tamper-proof store nor an atomic filesystem snapshot. Files are verified at the
  time of the operation; later edits require another check. There is no remote
  upload or Telegram document sending in this milestone.

## Evidence and release gates

The automated tests exercise byte independence, acceptance/state guards, source
changes versus destination failure, cancellation and owned cleanup, junction
escapes, metadata tampering, catalog write rollback, restart recovery, storage
changes, existing ZIP preservation, exact Windows file IDs and failed receipt
reconciliation. The shipped PowerShell verifier runs against real Unicode files.

`scripts/qa/vault-native.cjs` drives an actual Windows Electron profile without
accounts or inference. It covers preview/save, pause preservation, source
deletion, real complete export, storage changes, tampering, restart and deletion.
Native file pickers are supplied deterministic test paths while the production
IPC, filesystem, ZIP creation and readback remain active. Simplified Chinese,
Traditional Chinese, English and Japanese layouts include 150% zoom.

The production byte pipeline has also processed an incompressible
5,368,709,137-byte artifact into a 5,370,346,175-byte ZIP64 archive. The original
file was removed before export. Independent 7-Zip archive testing, full
extraction SHA256, the offline verifier and deliberate tampering detection passed.
The temporary fixture was removed after checking its canonical QA parent.
Evidence is retained under ignored `qa-output/vault-large-report.json`.

The final Windows suite passed 641 tests, with 43 platform-related skips in 88
test files. The native harness additionally force-terminates only its owned
Electron process tree during a 32 MiB archive export, restarts the same isolated
profile and reconciles the interrupted attempt through the actual interface.
The prior complete ZIP remains intact and only owned temporary files are removed.

Release requires the complete Windows regression suite, current-source native
acceptance, packaged startup/vault/Telegram/portable checks, installer wizard
inspection, exact ASAR/ZIP byte validation and full Gitea attachment readback.
Before publication, the packaged app passed two CLI startups, the native vault
and forced-crash recovery scenarios, existing delivery-center scheduling checks,
and Telegram tests against a local emulator. The portable app started successfully;
the Setup wizard opened without clicking Install. All nine packaged JS/CSS
bundles matched the build, and all 88 files extracted from the release ZIP
matched the unpacked application byte for byte. Attachment readback and public
download verification are recorded separately during publication.
Linux-specific development remains paused. The installed app hosting the current
agent and its accounts must remain intact.

## Primary references

- [Microsoft ZipArchive documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive?view=netframework-4.8.1)
- [Microsoft ZipArchiveEntry.Open documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchiveentry.open?view=netframework-4.8.1)
- [Windows file sharing and CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html)
