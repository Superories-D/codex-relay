# Codex Relay 0.6.25 — Windows delivery vault

Accepted artifacts can now be preserved as independent local delivery versions.
Review actual file counts, full byte totals and task states before saving. The
vault rereads and hashes both source and stored bytes, keeps workflow evidence,
and remains usable after the source workspace or task is removed.

Export complete ZIP/ZIP64 handoff archives with actual files, acceptance
manifests, offline HTML navigation, SHA256 checksums and a Windows artifact
verifier. Every ZIP entry is decompressed and rehashed before publication; no
artifact truncation, splitting or arbitrary two-minute acceptance deadline.

Storage can move to another disk while preserving previous versions. Operations
support progress and cancellation. Interrupted version publication and exports
have durable recovery; a completed ZIP can be reconciled after a failed receipt
write without exporting again. Deletion requires an explicit product confirmation
and affects only the owned vault version.

Windows CLI detection/official installation, user-owned Telegram Bot notifications,
workflow delivery center, model search and Git review remain included. Linux
development is paused. Windows packages remain unsigned.

Full delivery contains Setup EXE, Portable EXE, unpacked ZIP, INSTALL.txt and
SHA256SUMS.txt. See [delivery vault behavior and validation](DELIVERY-VAULT-20261025.md).
