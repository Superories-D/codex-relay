# 已有 Codex 会话接入（v0.4.0）

这个入口用于已经在普通终端或普通官方客户端中开始的任务，不需要重新填写任务目标。原窗口可继续工作；当需要交接时，Relay 停止已核实的原实例，将保存的本地会话迁入受管配置，再恢复相同 thread ID。后续账户轮换和额度等待复用现有调度器。

本功能已通过模拟进程边界、真实文件/JSONL 子进程与 Chromium UI 回归。Windows 原生进程识别、停止和官方客户端仍待真机验收。

## 支持范围

| 原任务位置 | 接入方式与边界 |
| --- | --- |
| Windows PowerShell / cmd / Windows Terminal 中的官方 Codex CLI | 读取本机 rollout、关联原生 Codex 进程；交接后可用 Relay CLI 或 Desktop 继续。终端宿主保留。 |
| Windows 官方 Codex 客户端普通窗口 | 读取本机主会话并关联 Codex 实例；交接会关闭整个选中实例，包含其中其他聊天和子进程。继续时使用新的受管 CLI 或独立 Desktop 实例。 |
| 已退出的本地 CLI / Desktop 会话 | 没有仍在运行且归属不明的 Codex 实例时可选择立即交接，恢复原历史。 |
| WSL、SSH、云端 Codex、IDE 扩展、第三方客户端 | 本版不保证接管。WSL/远程工作路径、子代理、外部历史依赖和动态工具会话会被拒绝或提示不支持。 |

不沿用原进程的 stdio、不广播 Ctrl+C、不自动改写原 `.codex/auth.json`。自定义 MCP、插件、外部工作树或应用状态不会随一个 rollout 自动迁移；涉及这些能力的任务需要先核实受管运行环境。

## UI 操作

1. 在 Relay「账户轮换」添加并启用接力账户。接入前暂停或取消其他待运行任务，避免两个 Relay 任务争用项目。
2. 点「接入已有会话」。默认目录来自 Relay 启动时的 `CODEX_HOME`，否则使用用户目录下 `.codex`。如果原终端设置了其他目录，手动选择它。
3. 点「扫描本机会话」，按任务内容、目录或 ID 筛选。列表显示最近 60 条；更早的会话可展开「按会话 ID 查找」。ID 精确查找包含归档目录。
4. 选中后检查「交接范围」中的 PID、程序路径及窗口标题。界面只允许操作这次检查确认的实例；进程集合发生变化须重新选中检查。
5. 选择交接时机与之后的运行方式。CLI 是主适配路径；Desktop 仍标记实验适配。
6. 勾选结束所列实例及子进程的授权后接入。监控期间审批仍在原窗口；迁入 CLI 后审批在 Relay，迁入 Desktop 后审批在受管客户端。

| 控制 | 行为 |
| --- | --- |
| 额度中断时自动交接 | 原任务继续运行；检测结构化额度证据后停止原实例、复制历史并接续。 |
| 立即交接并继续 | 下一次监控循环开始交接，可能中断正在执行的外部命令；恢复提示要求先检查已有结果。 |
| 暂停任务（未交接） | 完成停止与历史迁移，但暂不启动新的 worker。 |
| 取消接入（未开始停止） | 停止 Relay 监控，原窗口保持原状态。停止已开始但未确认时不允许跳过检查。 |
| 从托盘退出 | 暂停受管任务及监控；尚未交接的普通窗口继续运行。再次打开需恢复检查。 |

交接后的原历史文件仍保留。请在 Relay 管理的任务中继续操作；如果原历史又被写入，Relay 会暂停并冻结该任务的自动启动，避免两边继续写同一项目。

## CLI 操作

先保持 Relay 主程序运行：

```powershell
node scripts/relay.cjs sessions
node scripts/relay.cjs sessions --home "D:\CodexHome"
node scripts/relay.cjs attach --session <原thread-UUID> --when quota --mode cli --allow-stop
node scripts/relay.cjs attach --session <原thread-UUID> --when now --mode desktop --allow-stop
node scripts/relay.cjs handoff --id <Relay任务UUID>
node scripts/relay.cjs watch --id <Relay任务UUID>
```

`attach` 会先扫描指定线程、输出进程范围，再提交接入。原实例仍运行时必须显式提供 `--allow-stop`；它授权关闭列出的实例以及子进程，Desktop 实例的其他聊天也会停止。Ctrl+C 只断开 CLI 查看器。

## 交接约束

- 用 Windows Restart Manager 查找实际打开该 rollout 的进程，再沿 Codex 父进程向上定位实例。PID、创建时间、程序路径和当前用户归属共同校验；不接受 UI 提供任意 PID。
- 找不到文件持有者、但系统还有无法归属的 Codex 进程时，拒绝猜测。关闭原实例后可重新扫描保存的会话。
- 停止前先持久化阶段和进程身份回执。GUI 先请求关闭，再按需要终止；CLI 结束已确认的目标进程树。每次停止前再次校验进程身份，进程消失或 PID 复用不被当成新任务完成。
- 外部命令都有超时；停止或复制失败进入“需要处理”，不会启动第二个 worker。原进程停止结果不确定时，重启或取消也不能绕过恢复检查。
- 原实例存活期间由它负责刷新登录信息。Relay 暂停账户刷新；交接时等待已排队的账户操作结束，再只读原实例最终登录缓存，同身份已导入账户可更新本机加密库。
- 历史读取首次完整扫描、以后只处理追加的完整 JSONL 记录，跨块 UTF-8 不提前解码；不通过有限尾部窗口推断整个 turn。单个文件上限 128 MiB、单记录处理上限 16 MiB。
- 复制前后核查文件指纹，保留所有完整记录。只舍弃末尾因中断留下的半条记录，不修改原文件。受管副本采用 Codex 的 `sessions/YYYY/MM/DD` 布局和带时间、thread ID 的标准文件名。
- 首次恢复使用实验性 `thread/resume.path`，并检查返回 thread ID 与原 ID 一致；收到恢复确认后才转为常规 ID 恢复。该接口及标准历史目录扫描对照 `rust-v0.162.1` 源码，升级 CLI 后应复验。

## 为什么额度耗尽不会被当成完成

每个 turn 的额度证据持续保留，只有新的 `task_started` 才重置。即使后面出现 `task_complete`，先前的额度错误仍优先触发交接。监控原窗口时，正常完成要求终止记录稳定、匹配当前 turn、有最终答复，并成功复查额度；复查后再读一次原文件，防止检查期间出现迟到的额度事件。

已经结束的历史任务不会因开启监控而自动发送“继续”。应显式选择立即交接。原进程退出、用户中断、网络错误、无法读取认证缓存或无法确认最终原因都进入需要处理。人工暂停也不会自动恢复。迁入 Relay 后，如果全部账户耗尽，保持等待，到点向服务器复查可用额度后再继续。

## 排查

- **没有会话**：核对原终端的 `CODEX_HOME`；只有云端记录无法迁入。过大、损坏或不支持的记录会给出扫描提示。
- **进程列表已改变**：重新点击候选会话检查范围，不要反复直接提交旧结果。
- **没有文件持有者，但仍有 Codex 进程**：无法可靠定位，关闭原 Codex 实例后重新扫描。
- **原进程已退出且未确认完成**：点击「立即交接并继续」恢复保存的任务；不会把意外退出当成成功。
- **停止未确认 / 子进程仍存在**：先检查原任务的外部命令；恢复按钮会重新核查，队列保持冻结。
- **交接后原文件变化**：停止从原客户端恢复该任务，检查两边修改；Relay 不自动合并分叉历史。
- **额度复查失败**：保留任务，可立即交接交给已登录账户继续。只存操作系统密钥链且没有可读 `auth.json` 的源会话，可能无法在原窗口监控阶段完成最终额度复查。

实现依据：[OpenAI app-server 文档](https://developers.openai.com/codex/app-server/)、[v0.162.1 ThreadResumeParams](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[Windows RmGetList](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist)、[RM_UNIQUE_PROCESS](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_unique_process)、[RmStartSession](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmstartsession)。
