# Round 02 — Actionable attention inbox

A dedicated inbox collects outstanding command/file approvals, questions, manual failures and completed turns to review. It orders actionable decisions first and links to the actual conversation (questions open the question panel). Search and project/category filters separate current decisions, completed work and snoozed items.

Snoozing is local, expires after 30 minutes and never approves/resumes tasks. A changed request or a newer completion invalidates an old dismissal. Mark-seen applies only to that completion; reopening or completing a later turn reappears. Pending responses, archived jobs and automatic recovery do not create false manual action items. Malformed preferences remain preserved and do not block viewing the underlying tasks.

Tests verify authority is untouched, ordering/exclusions, expiry, signature invalidation and corruption handling. Production browser scenarios cover the actual modal, filtering, snoozing, reopening and completed-turn acknowledgement.
