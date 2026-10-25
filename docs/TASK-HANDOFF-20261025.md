# Windows task handoff and branch review

Status: Windows production source in development after complete v0.6.28.
Linux-specific work is paused. No v0.6.29 release tag or formal release exists.
The incomplete development snapshot is separate from the released main branch.
The user resumed the persistent iteration goal after the prior round was paused.
Continue the Windows milestone from its retained development snapshot and evidence.
The milestone still requires complete topology choices, guarded original-source
adoption, partial-phase reconciliation and a complete packaged Windows release.
Compatible child-repository assembly is implemented. A helper-only release does
not satisfy the milestone.

Implemented: independently retained raw payload/index/shared-index/history;
explicit dirty checkpoint baseline; private two-parent candidates; per-path,
manual and complete-tree conflict resolution; sparse/shallow/SHA256 handling;
full-byte drift verification; four-way paginated inventory and inline content
review; fresh revisioned acceptance; proof-bound paused continuation admission.
Original source/task indices, HEAD/config and pause/cancel intent are preserved.
New continuation reports start empty, and catalog failure after Scheduler commit
reconciles the same proven task without duplication or automatic inference.

Content review streams complete bytes for SHA256, Git identity and strict UTF8
classification, retaining only a bounded transport page. It preserves CRLF/BOM,
aligns Unicode display boundaries, supports text/hex and byte navigation, and
keeps retained raw/index/undo layers separate from current candidate edits.
Sparse content comes from owned objects; ignored setup comes from independent
archives. External link targets are metadata, never traversed for content.

Lost final seals now reconcile archives, snapshots, merges, resolutions and the
final workspace. Archive recovery verifies all payload/index/pack bytes against
the original durable plan. Snapshot/merge recovery independently rebuilds a new
private proof before reconciling the original pin and receipt. Resolution recovery
rebuilds an alternate index from planned stage choices and independently checked
manual blobs, preserving any later working edits. Existing corrupt receipts and
incomplete/changed artifacts are never overwritten. Missing earlier JSON or
unfinished payload/index/worktree phases still need fresh-attempt reconciliation.

Current combined regression: 57 passed across 7 files (212.03s), covering actual
Git, source removal, raw/index/REUC/sparse data, links, full binary/Unicode bytes,
cancellation, missing seals, proof reconstruction, tamper preservation and task
stop intent. Seven real-Git/Scheduler admission cases and the earlier 109-case
Scheduler/service/locale regression are separate evidence.

Actual Windows Electron main IPC/UI passes 5 flows and 4 locales, including full
8MiB binary verification, final-byte navigation, exact four-pane CRLF, conflict
resolution, acceptance, paused admission and restart/duplicate handling. The
expanded native test also restores all nine archive/snapshot/merge/resolution/
workspace seals through the real UI after detail loading fails. Final packaged
validation is still required. Production renderer content/acceptance tests pass all
4 locales including English 150% zoom. No model or external Bot message was sent.

## Product outcome

An isolated task should produce a concrete handoff proposal that a person can
review against the current source project. Show the checkpoint starting state,
current source state, task result and fresh acceptance evidence together. Build
the integrated result in an owned new worktree, preserving the source workspace
and its staged/working distinctions. Conflicts need an explicit resolution path.

Adoption is a separate user action bound to a fresh review. Opening an integrated
workspace and creating a paused continuation are useful without replacing source
files. Switching an existing source workspace additionally requires a compatible,
reviewed current state and a durable recovery record. Dirty or externally changed
work must remain recoverable. Never silently reset/stash the source, infer a push,
reuse stale acceptance reports or undo either task's pause/cancel intent.

## Required behavior

1. Bind source, checkpoint and result identities, repository format/common-dir,
   HEAD/branch/index stages/flags/resolve-undo and complete selected file hashes.
   Review after task stop; preserve the difference between committed changes,
   staged changes and working bytes. Show selected ignored/setup dependencies.
2. Retain independently verifiable objects and raw payloads. Produce proposals
   with complete binary/Unicode content, not a bounded text patch or a truncated
   renderer diff. Use progress/cancellation and full paginated inventory.
3. Compute integration in private metadata and a fresh owned target. Preserve
   source HEAD/index/working bytes on conflict, cancellation or storage failure.
   Do not execute repository merge drivers, filters/hooks or setup scripts merely
   to preview a proposal. Any needed external behavior requires a product choice.
4. Keep conflicts as structured, stable path/stage records. A tree containing
   conflict-marker blobs is not a successful handoff. Support review, resolution,
   re-verification and retry without duplicate branches or overwritten targets.
5. Save plans, manifests, object pins, per-attempt identities and completion
   receipts before linking continuations or adopting a source workspace. Reopen
   after crash, reconcile the existing attempt and preserve modified targets.
6. Carry checkpoint/task/workflow/delivery provenance. Acceptance is evaluated
   against the integrated result and explicit criteria. Review alone submits no
   model inference or remote push. Telegram remains user-configured notification.
7. Test divergent commits and dirty index/working states, conflicting text and
   binary changes, renames/deletions, large content, source removal, stale review,
   failed writes, cancellation, concurrent attempts, restart and four Windows
   locales. Publish complete Setup/Portable/ZIP plus metadata and full readback.

## Initial investigation

The v0.6.28 checkpoint format retains raw working files, the original index and
independent packed objects, and restores private or linked worktrees. Its source
review is asynchronous and cancellable; paused task admission records immutable
provenance and copies captured acceptance checks while resetting reports. Reuse
those identity/publication boundaries and Desktop's canonical repository queues.

Git's modern merge-tree can compute a tree without updating a workspace or index.
Its NUL output distinguishes conflict stages and stable conflict types. A
successful object computation alone does not establish raw-byte fidelity,
preservation of dirty source state, or safe adoption. Standard committed-history
merge bases and checkpoint working-state bases answer different questions; the
UI must identify the chosen baseline rather than silently substituting one.

Start with an owned real Git prototype: retain separate source/task snapshots,
compute a clean integrated proposal and a deliberate conflict, read back every
selected binary byte, and prove the original source and task index/working states
are unchanged. Determine installed Git capabilities before choosing command flags.

The first Windows-native prototype now passes on Git 2.50.1.windows.1. It imports
independent source/task snapshots into a private repository, merges divergent
committed and raw working changes, materializes the result in a new worktree and
reads back an entire 8 MiB Unicode/bracket-named binary. Mixed CRLF/LF working
bytes and local source additions survive. Ignored credentials remain excluded.
Original source/task HEAD, branch, raw index and complete selected file hashes
remain unchanged. A deliberate conflict returns exit1, stages1/2/3 and stable
NUL-separated conflict metadata rather than a successful proposal.

A second pass makes the proposal a two-parent commit and pins both snapshots,
the proposal and conflict objects in one reference transaction. Explicit private
Git garbage collection retains every pin; a full binary readback from the object
database still matches SHA256. Evidence is retained under ignored
`qa-output/handoff-probe-report.json` and its owned fixture. This is investigation,
not a shipping merge engine, durable adoption protocol or finished handoff UI.

The dirty-checkpoint baseline probe and production regression both pass: using
the checkpoint working tree integrates a task edit and a distant source edit,
where substituting the old historical commit creates a false conflict. The
product must still expose that baseline choice and its provenance explicitly.

Still required: actual child-repository proposals and dependency choices,
recovery of earlier incomplete sealing phases,
guarded source-workspace adoption/recovery, and complete native/packaged
release acceptance. New-candidate paused continuation is implemented and tested;
it does not establish recoverable in-place source adoption. The service currently records initialized child heads explicitly and
leaves such candidates in needsDependencies; it does not assemble child results.
Avoid converting a raw
working snapshot into a silently staged/promoted Git change merely because the
private merge computation succeeded.

Primary references: [merge-tree](https://git-scm.com/docs/git-merge-tree),
[worktree](https://git-scm.com/docs/git-worktree), and
[update-ref transactions](https://git-scm.com/docs/git-update-ref).

## Current official product comparison, 2026-10-25

Official OpenAI documentation describes moving conversations between Local and
Worktree, carrying uncommitted changes, and selecting ignored setup files through
`.worktreeinclude`: [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).
It also documents repository selection, staged/unstaged/branch/last-turn review,
full source navigation, inline feedback and staging/reverting at several scopes:
[Code review](https://learn.chatgpt.com/docs/code-review?surface=app).
These are comparison requirements, not evidence that Relay has reached parity.
The content inspector now reads retained raw, index and resolve-undo layers and
the candidate's current edits. It scans the complete file for SHA256, independent
Git blob identity and strict UTF8 classification, retaining only a transport byte
window. UTF8 boundaries align without replacement characters; raw byte pages stay
exact. Binary bytes outside a displayed page still determine binary classification.
Sparse objects are read from the private repository; selected ignored setup is
read from independent archives, and native links never traverse into targets.
Reading is cancellable, and list polling carries a result token rather than the
content payload. The UI exposes four panes, text/hex, layer/stage selection and
byte navigation. Original sealed content and current edits remain distinct.

Current content evidence: 23 tests pass across content/payload/service/i18n,
including deleted original sources, sparse indexes, actual resolve-undo stages,
external junctions, mid-read mutation/cancel and service cancellation preserving
candidate status. Actual Electron IPC/UI also passes 4 flows and 4 locales, with
full 8MiB binary verification/final-byte navigation and exact four-pane CRLF.
The latest Electron run also includes the final renderer refresh/detail-failure
guards. Four-language synthetic UI regression additionally verifies recovery
remains reachable without initial detail and does not loop failed detail requests.
Complete packaged acceptance remains required.

Child-repository assembly and guarded original-source adoption must be usable
end to end before making broad experience claims. Four-layer raw/index
evidence and fresh admission proofs are concrete current design choices whose
practical value still needs complete release acceptance and user evaluation.

## Next Windows integration constraints

Git submodules have independent histories, and a parent gitlink names the child
commit expected at that path. Child proposals must therefore preserve their own
repository and commit proof, with explicit parent/child assembly rather than
flattening nested files. See [Git submodules](https://git-scm.com/docs/gitsubmodules).
The current [git-init documentation](https://git-scm.com/docs/git-init) states that
SHA1 and SHA256 repositories do not interoperate; mixed graph formats need actual
installed-Git validation and explicit unsupported dependencies where necessary.

End-to-end original-source adoption remains required. Windows
[ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)
supports a backup but has several partially completed failure states, and its
WRITE_THROUGH flag is unsupported. Recovery must inspect real file identities
and retained bytes rather than assume an API failure changed nothing. Backups
and replacement staging must respect volume boundaries. File sharing through
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
needs deliberate coordination, and
[byte locks](https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files)
do not constrain memory-mapped writes. The implementation needs fresh source
guards, durable per-path plans and independent backups, guarded refs/index
changes and recovery that preserves subsequent external edits. These are design
requirements, not a claim that native source adoption is already safe or present.

## Child graph, mounted assembly and independent attempts

Child proposals now import each repository's retained history, raw working files,
original index stages and ignored setup into independently owned repositories.
Parent candidates wait for explicit assembly. Assembly creates a fresh parent,
updates submodule gitlinks to the selected child commits and mounts fresh child
worktrees; nested repositories retain their own histories. Setup selection copies
complete retained bytes without staging them. The same setup decision is available
to a plain root project without inventing a child graph. Missing-role, mixed-format
and changed-topology nodes currently remain blocked pending explicit choice actions.

Three actual Git graph tests passed, including submodule/nested assembly, complete
binary content, deleted originals, child conflict resolution and catalog recovery.
Four-language renderer graph tests passed, including 150% zoom. A dedicated actual
Windows Electron graph flow is still running; this is not packaged-release evidence.
The direct composition test also exercises incorrect bindings, path collisions and
tampered records; the final expanded regression is pending.

Failed or interrupted attempts now expose two distinct ways to create a new record.
Retained mode recomputes integration from the original independent archives and can
work after the original directories disappear. Recapture mode explicitly rereads
the current source and task against the original checkpoint, refusing a changed
starting baseline. Both record their predecessor, use new owned directories, retain
old candidates and later edits, reset acceptance/admission evidence and deduplicate
requests. Retained replay and plain-root setup recovery passed their focused actual
Git checks. The combined service/composition/checkpoint/locale regression now passes
all 30 checks. The complete actual Windows graph flow also passes conflict
resolution, complete binary reading, assembly, fresh acceptance, paused admission
and restart. A subsequent real Electron check confirms that assembled child review
and content tokens target the actual mounted copy, including its untracked setup.

For the required future adoption transaction, Git's
[update-ref documentation](https://git-scm.com/docs/git-update-ref) provides old-value
verification and an explicit prepare/commit/abort protocol. It also states that
concurrent readers can observe a subset of multi-reference changes. Therefore a
cross-repository adoption journal must reconcile each actual ref/index/file state,
including after partial interruption, rather than treating a batch of references
as a filesystem transaction. The independent alternate-index approach follows
[update-index](https://git-scm.com/docs/git-update-index); no original index update
should be inferred from merely assembling and reviewing a private candidate.

The adoption foundation now has a native Windows file component and a separately
tested multi-file journal. Every ordinary-file transition binds exact file identity,
complete bytes, permissions, attributes and stream metadata. The helper denies
concurrent write/delete handles, retains an independent flushed original and the
actual moved original, then moves the held replacement handle to an exclusive
destination. Original creation time, ACL and ordinary attributes are retained;
hardlinks, alternate streams and special storage attributes require explicit
handling before this component can adopt them. See Microsoft's
[file rename structure](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
and [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).

Ten actual native file checks pass, including complete 64MiB Unicode replacement,
permissions/attributes, stale identity, write sharing, long paths and junction
retargeting. Four managed-process checks and fifteen existing native process-domain
checks pass. The native launcher was corrected to use ordinary executable paths
when they fit, preserving explicit executable identity and existing long-path
handling; this avoids a verified CLR configuration initialization failure.

The journal prepares all desired content and native guards before source mutation,
retains raw metadata backups, records each actual file state and refuses duplicate
application. Recovery prepares fresh per-path finish/restore/keep transitions bound
to the complete observed state and retains every previous journal. Six focused
native transaction/recovery checks pass, including preserving later user edits
while restoring other selected originals. Final current-source reruns are tracked
in QA output. This foundation is not yet wired into the product's source-adoption
interface or complete repository admission policy; it does not establish completion
of original-source adoption. New-directory/link/structural handling, complete
repository guards, topology choices and packaged acceptance remain required.

## Original-source preview and metadata leases

The product now exposes a read-only original-source preview through the real
Handoffs service, IPC and renderer. It requires current acceptance, captures the
complete original source independently, compares it with the retained source,
and inventories the exact assembled root and mounted children. Completed previews
have immutable plans, source/metadata proofs, receipts and a paginated history
that reopens after restart. Page size is a transport choice; all files and full
SHA256/byte counts remain in the plan. Later source changes reject a new preview
instead of treating old evidence as current. Creating a preview does not apply
the native transaction or create/resume a task.

New files, directories, changed links, sparse paths and structural differences
remain explicit policy decisions. The eventual source-application policy must
also define what an omitted ignored setup means; omission must not silently
authorize deleting original configuration. The native transaction/application
and per-path recovery controls still need complete product integration.

Repository guards bind raw index, HEAD, configuration, packed refs, shallow and
sparse metadata to actual directory and file identities. Exclusive owned locks
protect index, configuration (including worktree-specific configuration), packed
refs and shallow metadata. Prepared Git verification transactions protect the
reviewed branches without updating refs/reflogs. Git also locks the primary HEAD;
only linked worktrees need a separate manual HEAD lease. A second metadata check
runs after all leases are held. Cancellation aborts the Git transaction and only
removes exact owned lock files. Forced-crash lock reconciliation is still required;
normal cancellation evidence is not a claim of complete crash recovery.

Git for Windows 2.50.1 checks explicit GIT_DIR against PATH_MAX minus 40 bytes
before ordinary repository processing. See its
[setup implementation](https://github.com/git-for-windows/git/blob/v2.50.1.windows.1/setup.c#L937).
Deep capture/inspection directories therefore use short junction aliases created
only inside each owned temporary process home. The full files stay at their
original paths. Recognized path-query results map back to their original physical
paths, and cleanup unlinks the exact aliases before removing the owned home.
Inspection initialization uses a relative target. Actual managed Git capture
passes with Chinese/Japanese inspection/index paths exceeding 260 characters,
retaining all original index/HEAD/raw bytes.

Focused source-preview service tests pass complete 8MiB binary evidence, preserved
user staging/raw changes, pagination, restart, duplicate requests, later source
drift and tampered-plan rejection. The renderer passes four language/layout checks,
including 125-row pagination and 150% zoom. The latest focused regression passes
all 40 tests across checkpoint capture/restore, the complete Handoffs service,
metadata/ref leases, actual managed long-path Git and locales. The new actual
Electron source-preview attempt did not complete: the application entered its
save-and-exit flow during assembly, so IPC rejected further requests. The origin
of that exit request is not established. Its partial candidate and records remain
in the isolated QA profile. Earlier successful mounted-graph Electron checks
remain separate evidence. No new Electron source-preview pass is claimed.
These checks do not establish packaged-release readiness or completion of source
adoption. v0.6.28 remains the latest formal release; the incomplete development
snapshot belongs on a separate development branch, without a v0.6.29 release tag.

## Resumed source application work

The original-project write and recovery service/IPC/UI are now connected. A user
chooses a policy for new files and for ignored setup omitted from the candidate,
prepares every complete replacement and independent original backup, reviews the
actual file/permission plan, then explicitly confirms application. The service
rechecks current candidate acceptance and source before starting, and holds
repository/index/ref leases across all mutations. Original staging and branches
are retained. Per-file recovery choices bind the complete freshly observed state;
later user edits cannot be overwritten by an old restoration request. Recovery
outcomes retain their own history, separate from the original transaction state.

New regular files derive permissions from the target project's parent using
[CreatePrivateObjectSecurityEx](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createprivateobjectsecurityex)
with the current creation token and file generic mapping. The resulting descriptor,
owner/group and parent ACL fingerprint bind the request. The helper uses
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
on the held staged handle, verifies inherited permissions after the exclusive move,
and rejects parent ACL changes. It does not inherit the protected backup home's
private ACL. Twelve direct native checks pass, including inheritance and stale
parent refusal. The managed transaction/recovery suite passes six checks; the
process-domain suite passes four when run without unrelated native tests that
would invalidate its global temporary-directory census.

The first product-service application run passes preparation, restart, full
8MiB+47 binary application/addition/deletion, retained index/config/HEAD and user
staging, explicit preservation of omitted ignored setup and mixed recovery that
leaves a later user edit intact. An expanded run also checks untouched source files
and fresh acceptance on the original project before sealing product success.
Latest exact-build and runtime evidence is tracked in QA output.

The exact isolated development build now passes five actual Electron application
checks: prepared-plan/permission review and confirmation, full native source write
with fresh source acceptance, refusal to overwrite later edits, mixed per-path
recovery, and restart of the same verified history. A separate actual child-graph
preview passes four checks, including exact mounted content and source integrity.
Four synthetic application layouts pass across Chinese, Traditional Chinese,
English and Japanese, including 150% zoom and 125 per-path recovery choices.
The focused source-service/lease/state/locale regression passes all 28 checks.

Recovery finish also retains a new file's originally reviewed parent ACL policy;
it cannot silently recalculate a different parent policy after permissions change.
Seven native transaction/recovery checks pass. Recovery display now verifies each
current file against the sealed recovery outcome before labeling it restored,
finished or retained. Two actual native inspection checks verify both correct
restoration labels and loss of only the affected label after a later user edit.
Earlier failed desktop runs remain recorded: instrumentation traced the quit to
the application's window-close handler; later harness fixes hide its test window,
wait for asynchronous command admission and select controls by name.

Remaining scope is substantial: actual application/recovery renderer acceptance,
complete forced-crash lease reconciliation and catalog publication recovery,
new-directory/link/structural operations, special-stream/hardlink/ownership policies,
missing-role/format/topology choices, full regression and complete packaged Windows
release acceptance. Regular-file service proof does not establish completion of
these requirements or desktop-experience parity.
