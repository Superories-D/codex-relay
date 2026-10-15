# CodexPilot 参考审查与 v0.3.0 改进

日期：2026-10-15。参考材料为用户提供的 `CodexPilot-Windows-v1.2.0.zip`，只读分析；没有执行其程序，也没有复制其中的凭据或整段实现。以下结论针对该快照，不代表其后续版本。本项目继续使用独立实现的 TypeScript/Electron 架构。

## 已吸收的功能

| 参考设计 | Relay 的实现与限制 |
| --- | --- |
| 多种账户备份格式（`auth_manager.py`） | 支持官方 auth.json、JSON 数组/accounts 包装、平铺字段、credentials 对象及 JSONL；2 MiB / 200 条上限。先预览、再勾选、逐条报告结果。重复和已删除条目跳过。 |
| 完成标记（`session_inspector.py`） | 可选且默认关闭；匹配最终答复最后独立一行。先检查终止原因及额度，标记不能覆盖额度中断。缺失时继续原线程，自动补完上限 0–10，默认 3 次，达到上限保留任务等待处理。 |
| 清晰的执行阶段（`orchestrator.py` / UI） | 从持久化任务状态显示准备、执行、确认停止、轮换等待、续接和完成检查；不依据定时器伪造进度。 |
| 环境与路径引导 | 设置页检查已保存的 CLI 路径、版本、Windows PowerShell；每个外部命令 8 秒超时，不登录账户、不创建任务。已有 Desktop 安装检测、控件诊断和窗口入口继续保留。 |

导入只带入身份与 OAuth 凭据，额度必须重新向服务核实。账户库继续使用 Windows DPAPI；预览返回的内容没有 access/refresh/id token。正在运行或需要恢复的账户禁止更新凭据。导入句柄 10 分钟失效且只能消费一次。退出程序会等待整批写入结束，不会因两个账户锁之间的间隙提前退出。

## 未沿用的行为

| 参考快照中的路径与行为 | 原因及 Relay 的处理 |
| --- | --- |
| `session_inspector.py` / `orchestrator.py` 把一般 HTTP 429 纳入额度耗尽分支；缺失额度时构造 5h 窗口及一小时后重置 | 服务节流与订阅额度耗尽不同。保留结构化额度证据，未知重置时间退避再核实，不制造服务端数据。 |
| `process_controller.py` 按 `Codex.exe` 进程名关闭所有同名实例 | 会影响用户其他窗口。只操作有 PID、路径、隔离 profile、启动回执共同证明归属的受管实例，必须确认停止后才轮换。 |
| `auth_manager.py` 默认投影到用户默认 `.codex/auth.json`；Windows 权限函数未实现保护 | 保留独立配置与 DPAPI 加密库。只读导入默认 auth.json，不覆盖默认登录；必要临时凭据留在受限目录并按恢复流程清理。 |
| `local_gateway.py` 整体读取响应并自动跨账户重试 401/429 | 未解决流式输出、请求是否已执行和重复外部操作问题。本项目没有透明重放网关，按已知会话与终止事件接力。 |
| `orchestrator.py` 的 Desktop 模式主执行分支仍调用 `run_cli_leg` | 不把它视为官方 GUI 已完整适配的证据。Relay Desktop 适配通过隔离实例、CDP 可见控件与对应 rollout 核实；仍需要真机验收。 |
| 完成标记缺失后可持续自动继续 | 增加有上限的补完预算；普通额度等待不消耗此预算，手动继续才重置预算。标记是附加协议，不是自然语言任务完成的证明。 |

## 调试证据

- `account-import.test.ts`：格式、身份冲突、重复/删除、损坏 JSON 脱敏、容量、预览无凭据、选择/部分失败、句柄失效、并发及整批退出等待。
- `completion.test.ts`、`cli-worker.test.ts`、`desktop-worker.test.ts`、`scheduler.test.ts`：标记精确匹配、额度优先、两种适配器同一规则、原线程续接、重试封顶、手动继续。
- `accounts.test.ts`：运行中的 CLI 账户不能被重新导入的凭据覆盖。
- `diagnostics.test.ts`：实际执行合成版本子进程、缺失程序、非 Codex 程序。
- `scripts/qa/ui.cjs`：实际构建页面的导入选择、完成校验字段、环境检查及既有交互回归；`scripts/qa/desktop.cjs` 检查真实 Chromium 中的控件操作逻辑。

完整边界见 [验证记录](VALIDATION.md)。没有真实 Windows、账户耗尽或官方客户端版本兼容性已验证的结论。

## Gitea 交付

目标是用户指定的私有仓库 `https://code.taiko.im/Superories/codex-go`。增加推送构建检查与手动 Windows 打包工作流；执行需要服务方可用的 runner。Windows artifact 上传按 [Gitea Runner 官方兼容说明](https://docs.gitea.com/runner/develop/cache/) 使用 Runner 3.x 的 action 兼容支持，不能仅根据服务器版本推断 runner 可用。
