# Context usage accounting — 2026-10-18

The screenshot's 46,867,019-token context meter used cumulative thread usage as
its numerator. `CliWorker` discarded the separate `last` snapshot, so long tasks
appeared permanently full even when their active context was much smaller.

The worker now preserves both counters. The context card uses `last.totalTokens`
against the supplied `modelContextWindow`, and labels it as the latest reported
usage. Cumulative thread totals and their input/output breakdown remain available
in a separate keyboard-accessible disclosure. The displayed context count is not
clamped; only the graphical percentage is limited to 100%. No window size is
inferred from a model name. Missing or invalid current counts show an unavailable
state, and missing/invalid capacity suppresses the percentage and meter.

Saved flat cumulative counters remain compatible. Old records that never saved
`last` cannot reconstruct their context occupancy and do not pretend to do so.
New updates replace the snapshot, including a smaller value after compaction;
duplicate updates are not added together. Goal accounting is unchanged.

## Protocol basis

The locally generated CLI 0.162.1 schema at
`qa-output/protocol-0162/v2/ThreadTokenUsageUpdatedNotification.json` and generated
`qa-output/protocol/v2/ThreadTokenUsage.ts` expose separate `total`, `last`, and
nullable `modelContextWindow` fields. Existing live-test reports contain the same
shape. The [official App Server event documentation](https://learn.chatgpt.com/docs/app-server#turn-events)
identifies `thread/tokenUsage/updated` as active-thread usage updates. Field-level
projection is based on the installed protocol; the documentation page does not
specify a continuously updated context estimator. This UI shows the last CLI
snapshot, not a client token estimate during streaming.

## Verification

- Build/typecheck passed; full suite **46 files / 401 tests**.
- Worker regression checks preserve totals and the current snapshot, avoid
  double counting, ignore unrelated/child-thread and obsolete-turn updates,
  accept reductions after compaction and remove a missing current snapshot.
- Accounting tests reject negative, fractional, non-finite, unsafe and nonnumeric
  values, retain valid zero usage and preserve cache/reasoning counters.
- Actual Electron, isolated empty-account profile: six saved cases cover
  45,000/200,000 context with a 46,867,019 cumulative total, compaction to 16,000,
  legacy totals, unknown capacity, zero context and exceeding capacity. Checks
  verify meter values, keyboard disclosure, four languages, Japanese light mode
  at 125% zoom, visible card bounds and persistence across renderer reload.
- Native QA initially queried animated disclosure content before it became
  visible and attempted to change renderer preferences through main-process IPC
  without updating renderer state. It now waits for content visibility and uses
  the settings UI. It also waits for the resized/zoomed viewport before checking
  bounds and taking screenshots; no application timeout or assertion was relaxed.

Ignored evidence: `qa-output/token-usage-tests.log`,
`qa-output/token-usage-native-report.json`, `qa-output/token-usage-native-zh.png`,
`qa-output/token-usage-native-ja-light.png` and isolated profiles. No inference,
credentials, installed profile, packaging or release changes were needed. Live
model/account recovery gates remain in `RELEASE-READINESS.md`.
