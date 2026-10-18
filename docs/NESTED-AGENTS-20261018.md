# Nested agent identity and turn ownership — 2026-10-18

Source after v0.6.16; existing packages and installed profiles are unchanged.

Three regression cases failed before these changes:

1. A root agent sending a message to a grandchild replaced the grandchild's
   actual parent. Subsequent activity summaries with null model/effort cleared
   its settings, and an interaction could mark a completed child running again.
2. Duplicate old `turn/started` and delayed child answers overwrote the active
   child turn. A stale quota-bearing completion could interrupt the parent.
3. A delayed `turn/start` response rewound the child to the requested turn even
   after notifications had advanced it to a newer turn.

The worker now preserves established parentage across collaboration summaries.
Only spawn/creation evidence introduces a new descendant; merely messaging or
waiting on a target does not establish ownership. Native `thread/started`
parentage remains authoritative. Missing model/effort metadata preserves known
values. Once a child turn is known, its own turn events/messages take priority
over unversioned parent snapshots. Interactions alone do not restart a child.

Child turn identities are deduplicated within the worker connection. Old-turn
events remain in child history but cannot overwrite current state, graph or
quota outcome. Start responses only initialize state if no newer observed child
turn has superseded the request. Old root-turn collaboration summaries likewise
cannot change the current graph. Public schema fields were checked against the
locally generated Codex CLI 0.162.1 protocol schemas.

## Verification

- Build and final full suite passed: 370 tests across 40 files. Local output is
  retained in ignored `qa-output/nested-agents-full-suite.log`.
- Three regression cases now pass in `tests/cli-worker.test.ts`, alongside the
  existing subagent controls, pending interruption and Goal lifecycle checks.
- `tests/supervisor-integration.test.ts` adds a real local subprocess workflow
  with root → child → grandchild, a cross-agent message, child quota exhaustion,
  confirmed old-process exit and account relay. It verifies the same root thread,
  retained parentage/model/effort and Goal objective/budget/accounting, automatic
  Goal continuation without a duplicate root prompt, targeted child continuation,
  a delayed start reply, targeted interruption, user pause and persisted state.
- The subprocess uses `tests/fixtures/agents-app-server.cjs`, a deterministic
  JSONL protocol peer with synthetic accounts. It does not contact OpenAI or
  run model inference; this is not real-account deep-agent acceptance.

Earlier real CLI parent/child evidence remains valid within its original scope.
Real-account deep hierarchies, provider failures, concurrent rotation and actual
task-output acceptance remain separate release gates.
