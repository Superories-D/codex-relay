# Round 8 — Template library with reviewed insertion

The template dialog is now a searchable library with instruction/model matching, recent/name sorting, favorites and per-project links. Favorites and project associations stay local to the user; template content and delivery conditions remain in the existing durable shared template store. Filtering does not mutate templates.

Selecting a template opens a full preview rather than immediately modifying the composer. Explicit insertion rereads the template store: deleted templates are rejected, changed templates refresh the preview and require a second confirmation. The existing composer callback appends to the latest draft, preserving user text; the preview explains the model/run settings and new-task-only delivery criteria.

Templates can be cloned with model, reasoning, planning, multi-agent and delivery conditions retained. Editing captures the original list revision. A rejected save refreshes the library but preserves the entire local form and does not silently adopt a newer revision, preventing a second click from overwriting someone else's winning edit. The user can save a new copy or explicitly discard and load the latest version. Deletion has a confirmation step, uses revision checks and never clears an unrelated form.

Validation: template-library tests cover project/favorite isolation, persisted metadata, full-prompt search, deterministic sort, changed-preview detection and safe copy names. Existing real template-store tests continue to exercise durable restart, stale concurrency, failed saves, corrupt storage and delivery conditions. Integrated browser evidence is recorded in the ten-round report.

Switching forms or closing with unsaved template changes now asks for an explicit keep/discard choice. Invalid or unknown favorites/queue-edit storage is not automatically overwritten: the UI offers a raw backup copy and an explicit reset, while mutations remain blocked. This also protects future-version data from being silently reduced to empty defaults.
