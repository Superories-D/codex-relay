# Codex Desktop 对齐与打磨记录

持续目标：完整打磨 Codex Desktop 的功能和 UI 细节，真实有用；特别关注子代理、自动账户接力和顺滑体验。按用户要求，在通过验证的关键节点提交 Git。以下记录用于区分已验证能力、仍在打磨的实现和官方服务边界，不把已显示控件等同于功能完成。

后续要求：多语言为标准功能，关键节点执行 **commit + push**。

已提交并推送：`b60afca`（2026-10-18），桌面工作空间和核心流程阶段一。构建、163 项测试、三种窗口宽度及界面流程通过。远程为 `code.taiko.im/Superories/codex-go` 的 `main`。

## 官方对照

2026-10-18 阅读了官方 [功能目录](https://learn.chatgpt.com/docs/features)、[桌面应用](https://learn.chatgpt.com/docs/app)、[集成终端](https://learn.chatgpt.com/docs/integrated-terminal)、[本地环境与 Git 操作](https://learn.chatgpt.com/docs/environments/local-environment)、[Worktree](https://learn.chatgpt.com/docs/environments/git-worktrees)、[代码审查](https://learn.chatgpt.com/docs/code-review)、[定时任务](https://learn.chatgpt.com/docs/automations)、[插件](https://learn.chatgpt.com/docs/plugins)、[设置](https://learn.chatgpt.com/docs/reference/settings) 与 [app-server](https://learn.chatgpt.com/docs/app-server)。界面同时以用户提供的真实 Windows Codex 截图为准。

## 阶段一：桌面工作空间与核心流程

| 工作流 | 实现与当前证据 | 后续验收 |
| --- | --- | --- |
| Windows 启动 | PowerShell 模块路径、重复目录 ACL 和 MSIX 原子写入修复；此前真实 EXE 验证通过 | 新版打包再验证 |
| 对话与自动接力 | 多轮、排队、补充、暂停恢复、完整聊天记录；v0.5 已做 3 轮真实模型验证 | 新 UI 下再做最小真实验收 |
| 界面 | 自定义标题栏、中性暗色、统一线性图标、侧栏、输入框、摘要面板；1440/1920/900 截图与控件回归通过 | 更多真实内容、窄窗口、缩放与空状态 |
| 模型与强度 | 实际目录、分档滑杆、重置、导入恢复；真实账户已验证 | 账户权限不同、不可用档位和快速模式 |
| 子代理 | 识别父子线程；独立消息记录；代理状态与结果；停止子线程；主任务等待运行中的子代理 | 真实派出两个子代理、独立回答、父线程汇总、次轮上下文恢复及刷新后查看记录通过；人工控制与多层跨账户恢复继续验收 |
| 集成终端 | 基于 CLI `command/exec` 的真正 PTY，xterm 输入、输出、尺寸、多个会话、隐藏保留 | 实际 Electron 中输入算式得到 42、尺寸调整、隐藏重开同一终端和关闭均通过；未发起推理 |
| 项目与 Worktree | 保存项目、选择目录、独立 Git Worktree 和起始分支 | 真实临时仓库中创建 Worktree 通过；项目组织继续打磨 |
| Git 更改 | 文件差异、暂存/取消暂存、还原确认、提交、推送入口、行内意见进入聊天草稿 | 真实临时仓库 stage/commit/diff 测试通过；PR、分块操作仍待补充 |
| 文件 | 懒加载目录树、文本/Markdown/图片预览、文本编辑、外部改动冲突保护、真实路径边界 | 单元测试与界面预览通过；PDF 内嵌和更多文件类型待补充 |
| 插件、Skills、MCP | 独立列表/详情界面、安装/停用、MCP 配置；客户端配置供新会话继承 | 界面回归通过；实际账户目录、工具执行与授权继续验证 |
| 定时任务 | 本地持久化、每日/每周/间隔、手动试跑、上次运行、避免重复并发、可选 Worktree | 日期计算与持久化测试通过；完整周期验收待补充 |
| 设置 | 常规、账户、通知、浅色/深色/系统主题、字体、个人 AGENTS.md、CLI 环境 | 账户/主题 UI 回归通过；更多设置细节仍在打磨 |
| 多语言 | 跟随系统、简中、繁中和英文；即时切换，按语言显示时间，保留用户内容原文 | 728 个静态界面键及公开操作名称覆盖检查、三语言切换和模型控件回归通过；原生窗口刷新后语言保留 |
| 会话管理 | 搜索、置顶、归档、重命名、原生 CLI 分支、按历史轮次编辑到独立分支、Markdown 导出；CLI/Desktop 本地历史导入 | 真实 CLI 的轮次截断、原记录保留、空分支、嵌套分支、重启持久化通过；原聊天内回退和文件撤销继续补齐 |
| 顺滑 | 50 ms 合并聊天推送、父/子会话订阅、增量历史缓存、消息复用、按帧自动跟随、保留草稿与阅读位置 | 万条历史约 20.8 MiB，追加并读取 P95 约 2.3 ms；80 条消息、20 Hz 更新时输入下一帧 P95 约 14 ms；复杂同步输出继续补测 |

源码和 UI 的当前验证不代表所有新工作流都已做真实账户验收。上一版稳定打包产物仍是 v0.5.0；待本阶段完整验收后再生成新版产物。

## 继续打磨的功能

- 子代理实际派出、发消息、等待、停止、父子层级、额度中断后的上下文恢复；不能只验证合成协议事件。
- 布局、字体、滚动位置、加载和错误反馈；对长对话与高频终端输出进行性能测试。
- 完整的 PDF/图片/代码预览，附件拖入与粘贴，文件引用与代码审查交互。
- 快捷键自定义、消息编辑与重发、撤销与重做、会话回滚、命令菜单、使用量详情。
- Worktree 生命周期与交接、Git 分块操作、分支、PR 工作流、本地环境操作。
- 插件和 MCP 的实际调用、登录、权限、配置生效；Agent 计划、目标、异步问题和全部公开事件类型。
- 多项目并行调度需要在账户令牌、额度与进程恢复控制上专门验证；不能直接把旧的单任务调度器改成不受控并发。

## 需要单独核实的官方边界

官方桌面专属的 Browser、Computer Use、Voice、Remote/Cloud、账户云同步、个人使用画像及 Pets 等依赖并不都由本机 CLI 提供。已有本地记录的导入与官方云端同步也不同。相关入口必须接上实际可用的官方公开接口或明确说明依赖条件，不能用装饰按钮或自动打开网页代替完成。私有服务与不可用能力保持在清单中，持续核实。

## 验证材料

自动化：`npm run check`。浏览器回归：`scripts/qa/agent-ui.cjs`。终端零推理探针：本地 `qa-output/terminal-probe.ts`。界面材料位于本地 `qa-output/agent-1920.png`、`desktop-file-preview.png`、`desktop-plugins.png`、`desktop-accounts.png`、`desktop-light.png`、`desktop-terminal.png`。

实际账户测试须控制任务规模，不故意耗尽额度；凭据、测试账户副本及生成目录不纳入 Git。

2026-10-18：`npm run check` 的 22 个测试文件、166 项测试通过。`scripts/qa/desktop-native.cjs` 在隔离配置和临时 Git 仓库内完成真实 Electron 文件编辑、冲突保护、暂存/提交、Worktree、真实 PTY 和语言持久化验收。浏览器回归同时验证简中、繁中、英文即时切换。详细本地结果：`qa-output/desktop-native-report.json`、`qa-output/agent-ui-report.json`。

阶段二的真实子代理和性能测量见 [验收记录](DESKTOP-LIVE-20261018.md)，不将未测试的人工子代理控制或深层恢复计入通过范围。

阶段三：分支改用 CLI `thread/fork`，历史轮次使用 `thread/turns/list`。编辑创建新分支后通过 `thread/revert` 排除选中轮次及以后内容，原聊天不变，待编辑文本进入新分支草稿。分页历史依赖 CLI 本地数据库，同一分支家族保留在客户端管理的同一运行目录，不再把元数据文件复制误作完整上下文。调度与维护操作仍串行，防止同一运行目录有第二个写入进程。原生验收：`scripts/qa/history-native.cjs`，本地报告 `qa-output/history-native-report.json`；无新增推理请求。CLI/Desktop 外部历史依赖仍需继续处理，不能把仅复制 JSONL 当作所有新版分支的完整导入。
