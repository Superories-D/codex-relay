# Reasoning summary display — 2026-10-18

The user's expanded reasoning entry showed JSON with empty `summary` and
`content` arrays. That particular record contains no displayable summary. Code
inspection also found a separate loss path: an empty completion frame replaced
previously streamed public summary text.

The chat reducer now assembles summary deltas by their paragraph index and keeps
received text when completion omits it. Native history hydration likewise keeps
an existing summary if the incoming item has none. Explicit `summary_text`
objects and native string summaries are supported. Raw/encrypted reasoning is
not used as a fallback.

Expanded entries render summary Markdown, a waiting message while running, or a
localized empty state after completion. Old records containing only JSON details
get the empty state without changing their journal. Previously lost text cannot
be reconstructed from empty arrays.

Validation:

- Final combined build and full suite passed: 380 tests across 42 files.
- Three focused tests cover indexed streaming, completion, persistence/restart,
  native hydration, summary-only conversion, four-language empty states and
  Markdown rendering.
- `scripts/qa/reasoning-native.cjs` passed in real Electron using an isolated
  synthetic profile: expanded legacy JSON becomes an empty state, summary text
  renders with paragraphs and emphasis, and changing language through Settings
  displays Japanese while preserving the original summary text.
- Native report and screenshots: `qa-output/reasoning-native-report.json`,
  `reasoning-native-zh.png`, `reasoning-native-ja.png`. No inference requests.
- The initial native harness read content before disclosure animation finished
  and changed preferences via IPC without the Settings refresh. Both harness
  errors were corrected; they were not language bugs in the application.

Source after v0.6.16. No package, installation or active-instance restart.
Whether the provider supplies a public summary for a particular real turn is
not guaranteed by these tests.
