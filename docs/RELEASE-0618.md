# Windows v0.6.18

Packages the verified source after v0.6.17, including automatic recovery, workflows, durable remote requests, task/subagent and multilingual improvements. Fixes include the missing packaged remote-store.cjs, bare rt.1. token redaction, Windows signal-exit/taskkill race, and Linux temporary plugin catalog backup exclusion. See ACCEPTANCE-20261024.md for the detailed source verification and remaining real-account coverage boundaries.

## Artifacts and validation

Local artifacts are in release/desktop-0.6.18: NSIS installer, self-extracting portable executable, complete unpacked ZIP, INSTALL.txt and SHA256SUMS.txt. No release binaries or private profiles are committed to Git.

- Build passed. The preceding full Windows suite passed 529 tests with 43 platform skips; Linux passed 570 with two platform skips. The subsequent Linux backup correction passed build and its targeted authenticated create/verify/restore regression. This packaging step changes only the version and release documentation.
- Packaged app reports 0.6.18 and isPackaged=true; Windows encrypted storage roundtrip, named-pipe API, Chinese navigation and empty-account behavior passed with no renderer errors.
- Final portable executable starts and passes the platform, Codex CLI 0.162.1, PowerShell and named-pipe checks using a fresh isolated profile. No model calls or account imports.
- Every bundled JS/CSS file matches the local build. The packaged remote CLI loads successfully, and remote-store.cjs is included. Private QA/runtime/Git data are excluded.
- ZIP integrity passed and all 86 files match the unpacked directory. Application and installer executable version resources report 0.6.18.
- NSIS reaches installation options and recognizes the existing all-users D:\codex-relay\Codex Relay installation as an upgrade. The probe closes without installing; the existing installation and profile remain unchanged.

The build used the existing Electron 44.7.0 distribution because the default download cache could not rename across disks. Windows packaging tools were extracted into an isolated cache without unused macOS symlinks. Executable version resources were edited successfully on a temporary filesystem copy before final packaging. These are build-environment workarounds, not application behavior changes. The artifacts are not publisher-signed.

## SHA256

- Setup: e955209b3f465bcd994deea55d2f49bca063643b370e29474b004106670febfe
- Portable: 359554a25908dc867d0720d31bec5a8ebd651c3ca748ef8b6ad2dd9395963791
- Unpacked ZIP: 645b7f2361493ab0004263e4f13d77b217209dc3a742e798f19faaf46ed733dc

Exit the client before updating and retain the original installation scope/directory. Do not overwrite the current token or restore old credentials as part of the upgrade. This delivery is local; no hosted release upload is claimed.
