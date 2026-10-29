# Round 7 — Recoverable follow-up queue editing

Queued follow-ups now have ordered compact previews, expandable full content and a separate editor per message. Unsaved edits persist locally by task/message, survive reloads and remain available when the original message leaves the queue. Departed edits are copy-only recovery material; the UI never recreates or resends a delivered follow-up.

The editor retains its original server base. When that same message changes elsewhere, saving pauses until the user compares the live version and explicitly chooses current text or their preserved edit. Queue revision checks remain enforced by the existing backend. Failed saves keep the form open and show the actual error. Reordering never clears drafts. Removing a queued message requires an inline confirmation carrying the captured queue revision.

The callback awaits the actual operation, rather than assuming success when the user clicks Save. Local-storage failures are visible with a copy-first recovery instruction. English/Japanese strings are supplied through the existing i18n dictionaries; Traditional Chinese uses the existing conversion layer.

Validation: queue-edits tests cover original-base preservation, remote conflicts, delivered/removed messages, persistence reload, per-message isolation and malformed storage. Production-renderer browser checks are collected in the integrated ten-round report.
