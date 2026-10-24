# Windows recovery domains — 0.6.27

A verified Windows CLI recovery owner now holds its own account, canonical
project/workspace paths and session family. Independently runnable CLI work can
use another account and project while that owner remains live. Unknown ownership,
old process markers, imported/existing permissions, Desktop and full-access
contexts retain a global hold.

## Process ownership and receipts

Windows CLI app-server starts through the bundled native RelayJobHost.exe.
The native host creates a private kill-on-close job with no breakaway flags.
PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the root at process creation, before its
suspended initial thread is resumed. Only the three duplicated standard handles
are inherited, so stdin/stdout/stderr retain their protocol behavior and the job
handle is not inherited by children.

A durable exclusive owner claim precedes launch. The host waits for its exact
PID acknowledgement, validates the launcher's creation identity and holds a
canonical-home mutex throughout the run. Durable per-run receipts bind nonce,
home, host/root PID creation times and job name. The prepared receipt precedes
root creation; the running receipt precedes resume. The host monitors the exact
launcher process handle, and root exit terminates remaining associated members.
Its last job-handle close also terminates associated members on failure.

Stop checks the exact recorded host identity, retains a job handle, stops that
host and verifies zero members. Release verifies the old domain and serializes
owner cleanup with the home mutex. Per-run receipts prevent delayed cleanup from
overwriting a replacement's evidence. An old release never deletes a different
nonce's marker. Runtime junction aliases resolve to the same canonical home.

Missing, malformed or inconsistent evidence stays blocked. Legacy PID markers
retain their conservative compatibility checks; they do not become evidence of
a new scoped domain. A helper startup or storage failure can leave evidence that
needs further inspection rather than silently discarding it.

## Admission and user intent

Before inference, the scheduler saves a binding between a new managed CLI domain,
its selected account, canonical workspace/project and requested read/write
sandbox. Existing/imported native contexts and full-access permissions are not
eligible for this scoped path. A command/file/permission/tool review withdraws
the binding durably before the request reaches the interface, because permission
review can widen the initial boundary.

Fresh recovery inspection validates the binding and every present job,
quota-probe and account-profile owner. Unknown or changed records remain global.
Proven scoped evidence is saved before it affects admission. Save failure leaves
the gate global. Restart never authorizes a scope from an old observation alone.

The same scope calculation drives scheduler admission, account exclusion and
cockpit blockers. Canonical path aliases, ancestor/descendant workspaces and shared
families remain held. Desktop candidates remain held during scoped recovery.
Related accounts stay out of selection; independent tasks can use other eligible
accounts. Dependencies, concurrency, warmup startup, dispatch and user stop intent
still apply. Resources are rechecked after asynchronous preparation.

Automatic cleanup still must prove ownership idle and save its final state
before releasing the original task. Pause/cancel remains durable even when a
cleanup attempt fails. Scoped admission does not itself resume the failed task.

This is isolation of observed managed runtime resources, not a guarantee about
arbitrary external services or file access by user code. Microsoft documents
exceptions to ordinary child-job inheritance (including WMI creation), and this
release does not claim universal containment of external processes. Unknown
external/session contexts retain global recovery checks.

## Recovery plan and history

Task operations opens the Windows recovery plan with each owner's scope,
reserved accounts/projects, affected queue, process count (including management
hosts), last check, retry time and preserved user intent. Links open the original
task. Recheck only reads ownership and saves evidence: it does not submit model
work or stop processes. Existing automatic recovery continues according to the
task's prior intent.

A plan identity guards reinspection. A stale plan refreshes with a clear message,
without applying a stale operation. History records allowed scope status, reason,
time and observed process count. Runtime resource paths and raw prompts are
excluded from that history projection. Local state/receipts still contain the
resource paths needed for ownership checks.

## Validation

- Full Windows source suite: **672 passed, 43 platform skips, 91 files**;
  TypeScript and production builds pass.
- Fourteen account-free native checks cover actual RPC Unicode/quote/backslash
  round trips, detached child ownership, mismatched receipts, root exit, host
  crash, explicit close, replacement-safe cleanup, runtime junction aliases,
  concurrent same-home launches and official CLI signed-out initialization.
- The actual scheduler, real native retained owner and filesystem prove that
  another project/account can start while shared project/family work waits;
  lost proof and legacy quota-probe owners restore global waiting.
- Actual restart revalidates live ownership, denied evidence persistence prevents
  admission, stale plan IDs reject, and failed cleanup preserves saved Cancel.
- Native Electron verifies corrupt-receipt fallback, stale-plan refresh, repaired
  evidence, retained runtime/pause intent and durable scope history.
- Simplified/Traditional Chinese, English and Japanese layouts pass; English
  includes 150% zoom, opaque themed surfaces and non-overlapping controls.
- Focused tests verify aliases/ancestor overlap, changed bindings during awaits,
  save failure/retry, missing owners and permission-review withdrawal before UI.

Native checks use isolated owned fixtures, no model inference and no external
messages. Real-account parity and arbitrary extension/service behavior are not
established by these fixtures. Linux-specific development remains paused.
Packaged native-host/scheduler checks, four-language recovery UI, operations
cockpit, two CLI startups, vault forced-crash recovery, local Telegram emulator,
delivery center, portable startup and Setup wizard passed. The wizard did not
install over the application hosting this work. Ten ASAR code/style bundles,
the native host bytes and all 89 ZIP files match the build. Full Gitea attachment
readback remains the publication gate.

## Primary research

[Microsoft job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
and [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
define membership, handle inheritance and breakaway limits.
[Creation-time job assignment](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/)
identified the crash gap in suspend-then-assign and informed the final atomic
creation path.
[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
documents the job/handle lists and Windows 10 minimum for job lists.
These sources informed the design; the runtime claims above rely on the actual
native and packaged checks rather than documentation alone.
