# Scheduled task clock and wake handling — 2026-10-19

Source follow-up to `SCHEDULES-20261018.md`, after v0.6.17. Existing packages,
release assets and installed profiles are unchanged.

## Corrected behavior

- Calendar recurrence constructs each candidate from its target date and the
  requested local hour. Previously, setting 02:30 on the spring DST transition
  could normalize it to 03:30 and carry that shifted hour into the next day or
  week. The corrected recurrence returns to the requested hour on the next date.
- Daily/weekly schedules follow the system time zone. The zone associated with
  `nextRun` is persisted. A detected zone change reprojects the next occurrence
  into the new local calendar, including after restart or while paused. This
  chooses the next future local occurrence; it does not backfill old-zone dates.
  Existing pending occurrence IDs and requested times are preserved. Legacy
  records without zone metadata retain their already-saved next occurrence on
  first adoption. Interval schedules retain their timestamp cadence.
- Electron's resume handler checks schedules immediately. Existing admission
  serialization collapses repeated resume notifications into one occurrence.
  Polling remains a 15-second fallback; multiple missed intervals collapse into
  one run. A backward clock adjustment waits for the existing next timestamp,
  avoiding replay of an already admitted occurrence.
- Schedule editing now explains local-time and wake behavior in all four
  languages. Zone bookkeeping is excluded from editable IPC payloads.

Local Date construction uses the runtime's standard transition disambiguation:
the earlier instant for a repeated time, and a shift through a nonexistent time.
See [Date local-time adjustment behavior](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/setHours).
This is not an OS wake service and does not execute while the machine is asleep.

## Evidence

- Build/typecheck passed. Final regression suite: **47 files / 409 tests**,
  recorded in `qa-output/schedule-clock-tests-final.log`.
- Four subprocess clock tests use real Node local-time calculations in New York,
  Lord Howe (a half-hour DST transition), Tokyo and Shanghai. They cover spring
  gaps, fall folds, exact-due times, year boundaries, interval duration, persisted
  zone changes and restart. No Windows system clock or time-zone setting changes.
- Four additional schedule integration cases cover a three-day forward jump,
  backward clock rollback without replay, disabled calendar reprojection,
  adoption of overdue legacy records and preservation of reserved identity after
  a failed zone-metadata write. Existing ten admission/recovery tests remain.
- `scripts/qa/schedules-native.cjs` passed in real Electron with an isolated
  empty-account profile. Three emitted resume notifications admitted exactly one
  overdue task in 66 ms before the periodic tick. The Japanese weekly template,
  time-policy note, save/pause/reload/delete and retained task history also passed.
  Evidence: `qa-output/schedules-native-report.json` and
  `qa-output/schedule-clock-native.log`.
- The first full-suite run exposed an ordering assumption in a Git branch test:
  canonical-root discovery can enqueue either simultaneous request first. The
  test now requires exactly one successful mutation, one stale-state rejection,
  the winning branch as HEAD, no losing branch and unchanged working content.
  The production Git guards were not relaxed; the final full suite passed.

The resume notification was emitted through Electron's actual `powerMonitor`
listener; the user's computer was not physically suspended. These checks prove
admission and calendar calculations, not scheduled model output correctness,
provider-side recovery after sleep or arbitrary OS time-zone notification delays.
Those live-account/physical-suspend gates remain open.
