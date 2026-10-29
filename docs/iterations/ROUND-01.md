# Round 01 — Composer version recovery

Each conversation/project composer now retains explicit recoverable text and attachment-reference versions (12 per composer, 40 globally, bounded storage). Paused typing captures a version without sending anything. The history dialog previews older content and replaces the current draft only on explicit choice, saving current text first and refusing replacement if input changed since preview. Pending admissions and attachment operations disable replacement.

History is separate from native submit/followup receipts, so a recovered version cannot acknowledge or resend a pending operation. Corrupt history is preserved, can be exported and explicitly rebuilt after backup acknowledgement. Quota/write errors retain the original history and current input. Tests exercise scope isolation, retention, duplicate suppression, corruption and failed storage writes; integrated browser scenarios verify actual recovery and reload.
