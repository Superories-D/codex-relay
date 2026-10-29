# Round 03 — Named task views

Task Center can save a named combination of project, search, task status, priority order and board/list layout. Apply restores the complete view; update changes both its name and filters, delete keeps current filters intact. Missing projects remain visible in the selector rather than silently widening scope. Duplicate names and more than 20 views are rejected.

Storage is versioned and strictly validated. Corrupt or inaccessible saved views disable writes and provide an original-data backup export plus explicit reset; opening Task Center never overwrites damaged data. Failed writes keep the prior in-memory view collection intact. Changed criteria are disclosed before update.

Validation: TypeScript and nine task-view/saved-view tests passed, including round-trip Windows paths, identity-preserving rename, duplicate detection, bounds and corrupt-storage handling. Browser integration validation is recorded by the root task after all rounds are integrated.
