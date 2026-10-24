# Windows verifiable delivery loop

This milestone turns declared deliverables into a client-enforced acceptance
gate. It covers task creation, actual file verification after worker shutdown,
durable results, dependent-task admission, repair drafts and workflow handoff.
Linux adapters are paused at the user's request and are not part of this release.

## Use the Windows client

1. Before sending a new task, open **+ → Delivery acceptance**. Add checks and
   save. The draft is stored per project and survives reopening the app.
2. Submit the task normally. The worker receives the declared conditions with
   the task instruction. Existing task text, attachments and permission policy
   are preserved.
3. After the worker positively closes, the client reads the actual files. A task
   reaches completed only after all configured conditions pass. Failed or
   unverifiable checks leave it needing attention, keep queued follow-ups, and
   hold dependent tasks.
4. Open the acceptance summary or the conversation menu to inspect evidence.
   **Add repair instructions to draft** appends a follow-up for review; it does
   not send it. **Verify again** rechecks files after manual repairs. A successful
   recheck can release this acceptance hold and advance already queued messages.
5. Export the redacted JSON evidence, including exact byte counts, SHA256,
   modification times, contract revision, turn identity and check timestamps.

Removing all conditions explicitly releases an acceptance-only hold. Other
execution failures, user pauses/cancellations and process-recovery requirements
remain effective. Starting another execution invalidates the earlier completion
claim; passing file checks cannot complete a later failed execution.

## Supported conditions

| Kind | Predicate | Evidence |
| --- | --- | --- |
| `file` | Regular file exists and meets `minBytes`; use 0 to permit empty files | Full-file SHA256, bytes and modification time |
| `contains` | UTF-8 text contains an exact literal, including across read boundaries | Same full-file fingerprint; invalid encoding is unverifiable |
| `sha256` | Complete file digest matches the declared digest | Full streaming SHA256; files are not truncated |
| `json` | JSON Pointer resolves to an exact string, number, boolean or null | Typed comparison plus full-file fingerprint |

Paths are relative to the task's actual working directory. Absolute paths,
parent traversal, alternate data streams and symlink/junction escapes are
rejected. File identity and metadata are checked before and after the read;
concurrent writes invalidate verification. This is evidence at a particular
time, not a guarantee that files cannot change afterward.

There may be 30 declared checks and ten retained reports per task. JSON parsing
supports UTF-8 documents through 4 MiB. File hashing and text search stream the
complete file; the verification operation has a two-minute deadline and can be
cancelled independently. Cancellation, unreadable files and unsupported JSON
sizes are recorded as unverifiable, never passed. Passing declared predicates
does not establish broader application correctness or replace functional tests.

## Durability and scheduling

The post-close verification marker is saved before checking files. After an
interruption, startup resumes that read-only verification rather than starting
another model turn. A storage failure rolls manual results and task state back;
dependency admission waits for the parent's active work and control transaction.
Report history remains associated with its original contract revision. Changing
a contract makes old evidence insufficient for the new contract.

Successful execution, accepted artifacts and manually prepared repair text have
separate meanings. The workflow handoff includes the latest acceptance report
and cannot claim completion while the current contract is unaccepted. Task
diagnostics also identify acceptance as a blocker.

## Local command API

Authenticated desktop IPC supports `delivery.read`, `delivery.save`,
`delivery.run`, `delivery.cancel`, `delivery.repair` and `delivery.export`.
`delivery.save` takes `{id, revision, checks}` and rejects a stale revision.
The other commands take the task UUID. A new `job.add` input may include:

```json
{
  "deliveryChecks": [
    {"kind":"file","label":"Report exists","path":"out/report.json","minBytes":1},
    {"kind":"json","label":"Accepted result","path":"out/report.json","pointer":"/status","equals":"accepted"}
  ]
}
```

The Windows UI provides these operations without requiring JSON commands.

## Verification and design references

`tests/delivery.test.ts` reads actual temporary files for full fingerprints,
Unicode boundaries, typed JSON, encoding failures, oversized JSON, traversal,
junction escape, concurrent writes and cancellation. Scheduler tests cover the
post-close gate, dependent tasks, preserved follow-ups, stale contracts, storage
rollback, restart verification, later execution failures and per-task cancellation.

`scripts/qa/delivery-native.cjs` runs real Electron with zero accounts: four
actual file checks, evidence download, file removal/recheck, appended repair
draft, restart and preserved history. `scripts/qa/delivery-ui.cjs` covers the
Windows production renderer in four languages, invalid JSON, failed saves,
downloads, project drafts and viewport bounds with controlled IPC.

The design draws on OpenAI's
[iterative repair workflow](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex)
and [durable long-running project guidance](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex).
This project implements the concrete predicates and scheduling gate locally;
those references do not establish parity with the complete Codex Desktop product.
