# 所有远端分支审计与合并依据

审计基准：`origin/main` = `1c9b2bc021f8a64154927899a926dd0c088fb8f4`。完整远端 head 列表通过 `git ls-remote --heads origin` 获取；原始 checkout 仅配置 main fetch，审计已显式 fetch `+refs/heads/*:refs/remotes/origin/*`。没有从目录名称推断分支。

## 分支总览

| 分支 | tip | main独有/分支独有 | 结论 |
|---|---|---|---|
| `main` | `1c9b2bc` | 0 / 0 | 保留此前三轮 Windows UI 与调度改动 |
| `codex/auto-recovery-20261022` | `f7c7393` | 18 / 0 | 完全祖先；无需重复应用 |
| `codex/continuation-20261027` | `c5c951f` | 3 / 45 | 45个真实增量提交，应整分支合并 |
| `wip/windows-handoff-20261025-5011a26c` | `2d1b5a3` | 3 / 4 | 4个真实增量提交，应保留完整依赖链合并，原生验证边界如后文 |

本地 `work` 为正在进行工作的 checkout 分支，不是额外远端产品分支。不删除任何远端分支，不重写其历史。

## continuation：45个独有提交逐项核对

共同基点：`3a99e6342ed4ee80f5fe10a1a9c7bfa165f63175`。`git cherry main branch` 全部为 `+`，没有仅名称不同的等价补丁。实际变更 144 个文件，约 +6220/-646；没有 package.json、依赖声明或锁文件改动。

| 提交 | 实际主题 |
|---|---|
| `8f1f1b3` | fix(server): preserve upload identity after payload loss |
| `8bc708c` | fix(remote): retain recoverable requests after ambiguous HTTP errors |
| `7d91e4a` | feat(remote): bind browser operations to verified server identity |
| `b375ad4` | feat(remote): automatically recover pending browser submissions |
| `d33ac56` | feat(remote): expose durable operation history and receipt inspection |
| `777b8b1` | fix(checkpoints): normalize Git paths and restore cross-platform checks |
| `2beed2d` | feat(server): deliver artifacts from authorized scheduled worktrees |
| `d9c70c9` | feat(windows): make Telegram history searchable and bound polling |
| `d2bed3b` | fix(workflows): preserve delivery gates across creation and retry |
| `77ebce8` | fix(server): report the actual bundled source version |
| `a2bd671` | fix(remote): enforce server identity throughout CLI retries |
| `302ea1d` | fix(schedules): enforce source project limits for isolated runs |
| `b0105b9` | feat(schedules): configure independent delivery checks for every run |
| `f0de7c3` | fix(scheduler): isolate state observer failures from committed work |
| `c621e49` | build: reject stale bundles before server packaging |
| `c128023` | build: stage server archives and preserve previous packages on failure |
| `ae50e1b` | feat(server): support explicit HTTPS proxy origins and live streams |
| `8155eb0` | fix(import): publish terminal progress after worker ownership ends |
| `0fb7abc` | feat(telegram): inspect delivery evidence and verify with durable receipts |
| `7cbad9d` | feat(remote): complete task delivery editing and recoverable verification |
| `ef9702e` | fix(remote): reconnect half-open status streams after heartbeat timeout |
| `f534a95` | fix(remote): isolate late attachment responses after task switches |
| `49f0c8d` | fix(server): resume shutdown-interrupted file verification after restart |
| `1198205` | fix(telegram): unblock updates after definitive attachment rejection |
| `52c8cd4` | feat(templates): reuse delivery contracts across desktop web and Telegram |
| `ed0db25` | fix(schedules): preserve reserved inputs and guard concurrent edits |
| `7c564a0` | feat(schedules): inspect and safely resolve pending task admission |
| `fa7d850` | fix(ui): coalesce slow refreshes and isolate stale schedule snapshots |
| `edf8cf2` | fix(checkpoints): distinguish completed pack transfer from premature input loss |
| `4d3e3cf` | feat(remote): recover task controls and queue edits from durable receipts |
| `a3610d4` | feat(remote): reconcile pending actions in the background across task switches |
| `3d312a0` | feat(telegram): inspect project changes and safe staged or working diffs |
| `5dfe609` | feat(web): inspect project diffs with bounded pages and responsive dialogs |
| `549fab6` | test(qa): await asynchronous browser checks before accepting their result |
| `dfe1d43` | fix(projects): preserve racy Git checks and reject invalid preview snapshots |
| `f55dca6` | fix(telegram): resume confirmed repairs without overriding later stop intents |
| `14a33d8` | fix(notifications): distinguish completed turns and retain current result summaries |
| `8786e44` | fix(recovery): finalize recorded successful turns without repeated inference |
| `19f33a3` | fix(chat): recover ordered journal writes after transient storage failures |
| `037f1f8` | feat(desktop): recover pending followups across reloads with durable receipts |
| `9c72b5f` | feat(telegram): send timely notifications alongside one durable command poll |
| `468b76b` | fix(shutdown): preserve Goal and completion authority across service restarts |
| `049ed10` | fix(goals): recover usage stops while preserving native budget and pause authority |
| `b89bc04` | feat(desktop): reconcile new chat admissions after lost replies and reloads |
| `c5c951f` | feat(telegram): admit caption commands with durable attachment recovery |

### 源码与行为审查

- 上传/CLI/browser可靠投递：保留已接受上传身份，防止丢失文件后复用请求；绑定安装身份、持久请求编号和请求体，拒绝服务器切换或旧任务迟到回包，恢复原请求而非重新执行。后台ActionRecovery仅恢复支持回执的白名单命令，有界并发、身份和限流故障保留。
- 原生桌面创建与追问：新增 NativeCreations、NativeFollowups、两类 renderer 恢复器，先保存意图，确认后只清理属于原请求的草稿/附件。取消写入 tombstone，不静默丢弃原用户输入。AgentApp 合并必须保留这些路径，不能用旧直接 job.add/chat.send 覆盖。
- Goal/停止/服务重启：新增 completionPending、completion revision、resumeAfterShutdown、controlRevision；区别系统停机与用户暂停/取消；确认已完成回合后只补验收/收尾，避免重复模型执行。Goal预算、later pause/cancel保持权威。
- 日志与通知：聊天写入队列可从暂时存储失败恢复，按完成回合而非updatedAt触发通知；故障观察者隔离，不能把已落盘成功倒退。
- 工作流/定时/模板：传递并迁移真实交付验收条件，不复制通过证据；定时每次运行冻结输入、独立报告，版本防旧表单覆盖、pending run显式处理；模板条件跨桌面/web/Telegram共享。
- Git检查/权限：ProjectGit通过独立索引和元数据、fd范围与目录身份检查读取，禁外部filters/hooks/textconv，不展开未经授权嵌套仓库；保留原索引时间语义避免racyGit漏报。
- HTTP/远程：HTTPS公开来源必须精确配置，默认loopback、鉴权、Host/Origin检查保留；浏览器/CLI发送server identity，SSE头部/静默期限避免假在线。
- 构建发布：源码+产物SHA manifest、staging package、发布锁与回滚，不先删除旧包。合并/新一轮改动后必须重新build再package，否则应拒绝旧产物。
- Telegram：caption附件请求持久化恢复，可靠控制/修复依赖观察版本，回复落盘失败后确认原回执。没有新增硬编码Bot凭据。
- 测试：新增真实文件/进程/Git/HTTP验证、浏览器异步等待AST审计；原有断言保持。分支自己的历史通过数量是该分支时刻，不替代合并后全套验证。

### continuation冲突取舍

1. AgentApp 合并追加功能：保留 main 首页、CommandPalette、专注与导航；保留 continuation 的创建/追问持久回执，模板 deliveryChecks 和草稿确认。
2. Scheduler 合并追加状态：保留 priorityMany 批量事务，同时保留完成回执、shutdown、Goal与控制版本。
3. main/runtime/http允许命令集做加法合并，不丢 jobs.priority。
4. locales import/spread additive合并。
5. checkpoint-git采用 continuation 的writeCheckpointInput抽取和路径规范化，同时保留 main 的稳定输入流回归测试。
6. checkpoints fixture保留跨平台绝对路径与安全清理；Windows-only原生资源复制仍平台限定。

## auto-recovery 与 handoff 详细核对

# Remote old-branch audit

Audit anchors: origin/main 1c9b2bc021f8a64154927899a926dd0c088fb8f4; audit conducted without checkout, source edits, merge or push.

## codex/auto-recovery-20261022

Tip f7c739384eabf157ab7726ea262ef55ce2b7f506, `feat(remote): persist cross-platform profiles and recover interrupted client requests`.

`git merge-base origin/main origin/codex/auto-recovery-20261022` is exactly the branch tip. `git rev-list --left-right --count main...branch` is 18 / 0. It is fully contained in main, not merely patch-equivalent. No unique code or merge action required. An ordinary merge is an already-up-to-date no-op. Keep branch unless user separately requests deletion.

## wip/windows-handoff-20261025-5011a26c

Tip 2d1b5a32511604f5ba22d263d0d5e1dcb6297ca3. Common base with main is 3a99e6342ed4ee80f5fe10a1a9c7bfa165f63175. Relative counts main / branch are 3 / 4. `git cherry main branch` reports four `+` entries, so no unique commit is an equivalent main patch.

Four unique commits, in dependency order:

1. 82e1c2cf2883937ae071fd9071c110f5e2d46dab — 83 files, +4098/-29. Establishes independent retained handoff archives; checkpoint/source/task snapshots; child repository graph integration; controlled merge conflict resolution; source previews; fresh acceptance; proof-bound paused continuation admission; content pagination; UI and localized strings; actual-Git tests. Adds initial native adoption helper and Windows long-path support.
2. 950815b732a802be49a3fd6ed847578bac0eb6ed — 21 files +360/-30. Connects original-source prepare/apply/recover IPC and UI; durable per-path backup/transaction records; native permission preservation/inheritance; preview acceptance binding.
3. 65200a0f418699773ad498f236a5580edf5d5e77 — 13 files +106/-9. Improves observed per-path recovery labels, source-acceptance verification and native/UI validation harness; source-written and later-modified files distinguished.
4. 2d1b5a32511604f5ba22d263d0d5e1dcb6297ca3 — 5 files +137/-4. Adds managed native Git repository lock lease process with Windows delete-on-close handles and repository identity validation. The latest increment is explicitly WIP, with only targeted runtime evidence.

Net unique branch diff: 94 files, +4658/-29. No package.json, lockfile, dependency or registry changes. Added paths are source, tests, QA and documentation; no credential/config payload files were added.

### Actual implementation review

- Scheduler.addHandoffTask runs under queueMaintenance, requires current acceptance/proof/workspace commit agreement, validates canonical project directory, creates paused stopIntent=pause task, copies delivery criteria but resets reports, and rolls back persisted admission failures. This adds genuine behavior absent from main.
- Handoffs service has explicit create/verify/review/resolve/inspect/admit lifecycle. There are 27 IPC operations integrated with desktop lifecycle shutdown/resume. UI entrypoints added to TaskCenter and Workbench; no background inference or remote Git push follows review.
- Native apply is Windows-only, binds UUID/hash/path/file identities, requires separately prepared permissions, checks current source/task authority and acceptance, holds repository leases across mutations, and persists backup/recovery evidence. Per-path recovery binds fresh observed state and permits explicit keep of later user edits. No clear automatic-source-write or credential-copy path was found in inspected apply/guard/native entrypoints.
- New RelayRepositoryLeaseHost.exe is compiled with RelayJobHost and RelayAdoptionHost on Windows; package extraResources already includes all dist/native, so no packaging declaration update is needed.
- Checkpoint changes have independent value: selected ignored files assigned to deepest Git repo, nested repository selected setup capture, preservation of external relative-link semantics, bounded streaming hooks and Windows long GIT_DIR aliasing.
- Dialog adds --dialog-available-height used by handoff UI; DeliveryDialog awaits async saveDraft before close. Retain these small compatibility fixes.

### Integration guidance

Use ordinary merge rather than squashing individual WIP files: its commits form one coherent dependency chain. Add the HandoffCenter imports/state/tool button/dialog to the redesigned TaskCenter and Workbench, preserving main's board/bulk operations and review-session functionality.

For checkpoint-git.ts, retain WIP consumeOutput/produceInput, long-path junction aliases and resolveOutputPath mapping, plus main's strict completed-byte `stdinFile` writer from 1c9b2bc. WIP's old pipeline(createReadStream, stdin) must not overwrite the already-proven race fix. Merge locale imports/spreads additively. Preserve current checkpoint temporary-path portability tests plus new nested ignored-file test.

Main source adoption is a powerful Windows-only feature. Documentation explicitly says forced-crash cleanup, partial lease acquisition, foreign-lock preservation and broader end-to-end regression were NOT validated for latest native lease increment. Other remaining milestones include topology/structural policies and packaged Windows release. This is a native-validation limitation, not demonstrated unsafe code. Merge must not be presented as release readiness. Consider a clearly experimental/native-unvalidated source-write status until actual Windows crash scenarios pass; parent owns product decision. User's new request to integrate branches supersedes historical WIP notes saying do not merge/restart.

Required regression after integration: TypeScript build; full unit/integration suite incl all handoff suites; main checkpoint transport tests; task-view/review-session tests; handoff renderer UI fixtures; Windows native compile and lease/adoption crash/cancellation checks where actual Windows runtime available. Linux passes cannot establish native Windows success.


## 实际checkpoint-git冲突整合

已按父代理授权，仅编辑并暂存 src/main/checkpoint-git.ts，未提交：
- 保留绝对scratch/cwd、统一writeCheckpointInput、字节未送达拒绝；
- 保留 handoff produceInput/consumeOutput完整流式接口，输入/输出冲突校验；
- 保留 Windows短junction路径、Git长路径配置前置、输出映射与清理身份校验；
- 子进程非零退出与EOF管道收尾相撞时优先报告真实Git退出码，只有这类已识别管道错误采用该诊断优先级，源文件读取错误仍拒绝。
- handoff把empty-hooks移到短私有Git home，continuation旧测试固定scratch/empty-hooks的精确位置断言需要改成验证绝对、空目录和隔离边界；不能为了满足旧路径断言回退长路径修复。

建议合并顺序：auto-recovery祖先检查 → continuation → handoff。合并后全量构建/测试，Windows原生崩溃/lease验证在真实Windows上单独记录，不能由Linux通过替代。

## 合并后验证发现与修复

- 10组handoff文件系统夹具使用旧Windows D:/相对路径，在Linux被当成相对目录，GIT_DIR与捕获源位置不一致。统一改为os.tmpdir下绝对独立目录，父目录独立创建，保留原owner、安全清理和内容断言；不改变仅供schema验证的D:/示例。
- 实际流式输出生命周期缺陷：内容提取器先await目录身份检查，短Git cat-file进程已经结束，Node自动排空尚未附着读取器的stdout，丢失完整对象头。添加即时接管的256KiB PassThrough与pipeline，延迟消费者仍可读取完整字节，大输出有背压；消费者失败销毁配对stream并保持错误。
- 新tests/handoff-output.test.ts用真实Git复现延迟150ms读取与2MiB背压/失败收尾；与原有2组失败套件共14项全部通过（3文件，25.66s）。
- 可移植10组套件首次73通过2失败；上述两项均为已定位并修复的真实stdout竞态，非降级/忽略断言。
- checkpoint输入/传输8项通过，Windows长路径1项依真实平台跳过。

## 本次合并完成记录

先合并 continuation，再合并 handoff；保留双方的恢复和任务工作台功能。合并后 TypeScript 通过。初次完整测试中1022通过，50项因 handoff 测试相对 Windows 临时路径失败；移植路径后73/75通过，剩余2项揭示真实 stdout 接收竞态。修复并加入延迟消费者／提前返回回归，受影响的服务、图审阅、流输出15项全部通过。最终完整套件将在后续十轮集成后重新执行。远端分支保留，无删除、重置或历史重写。

## 十轮完成后的最终验证

144 个测试文件：143 通过、1 Windows 专项跳过；1,115 项通过、13 项跳过、0 失败。十轮生产渲染器场景、13 组窗口／主题／语言及弹窗内层边界检查通过。所有远端功能分支均通过 `git merge-base --is-ancestor <tip> main`，参见 [精确 tip 包含证据](ten-branch-containment.json)。没有新建替代远端分支或删除原分支。
