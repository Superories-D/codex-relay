# 参考与兼容性记录

调查日期：2026-10-13。所有 URL 为公开参考；实现不包含参考仓库的账户数据、凭据或构建产物。

| 来源 | 本项目使用的机制 |
|---|---|
| https://github.com/jlcodes99/cockpit-tools | 账户档案与 auth.json 切换、Windows 独立实例目录、Store 包上下文启动、额度窗口概念 |
| https://github.com/openai/codex | app-server 协议、rollout 事件、账户与令牌存储、线程持久化行为 |
| https://developers.openai.com/codex/app-server/ | initialize、account/login/start、account/rateLimits/read、thread/resume、turn/interrupt、审批与令牌刷新 |
| https://developers.openai.com/codex/auth/ | 官方浏览器及设备码登录；文件/系统凭据存储 |
| https://developers.openai.com/codex/cli/reference/ | Codex CLI 路径、配置与运行方式 |
| https://www.electronjs.org/docs/latest/api/safe-storage | Windows DPAPI 加密存储与局限 |
| https://www.electronjs.org/docs/latest/tutorial/context-isolation | 隔离 preload、受限主进程 IPC |

克隆调查定位：

- cockpit-tools：`915e7a20b432546660c3cd15e90f9fa527490ecc`，重点查看 `src-tauri/src/modules/codex*`、`process_codex_windows_launch*`、账户/实例配置。
- openai/codex：`6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7`，重点查看 `codex-rs/app-server-protocol/schema`、`codex-rs/protocol/src/protocol.rs`、`codex-rs/app-server/src/request_processors/thread_processor.rs`。
- 本轮进一步核对 `rust-v0.162.1` 标签（`7a078f6bb4ce0dc2a81408b334ce52979d92c603`）：`thread_archive_impl` 会先持久化尚未发送首轮的新线程；archive 卸载线程后必须 resume 才能继续发送。
- 额外用 npm 官方 `@openai/codex@0.162.1` 在 Linux 隔离临时目录进行匿名本地协议核验，没有使用真实账户或执行用户任务。

### 不能假设的事情

- 某个任务不再输出 ≠ 完成。额度限制常以错误或自动中断表现。
- 窗口名称不能只按 primary/secondary 写死为 5h/周；界面依据实际 windowDurationMins 显示。
- `resetsAt` 是秒，内部统一转换成毫秒。账户中两个耗尽窗口必须都恢复。
- 新线程在首轮前可能不落盘；CLI/客户端均在 checkpoint 前显式持久化并重新载入。
- App Server 的 `SandboxMode` 线格式使用 `workspace-write/read-only/danger-full-access`；UI 内部名称不能原样发送。
- 外部令牌登录是实验性接口；当前版本启用 experimentalApi，不保证未来兼容。
- 客户端没有稳定公共 DOM，CSS 选择器需要按实际版本校验。
- 有 Windows 客户端忽略 CODEX_HOME 的上游报告（https://github.com/openai/codex/issues/34070）。因此目录隔离必须核对实际会话记录，不能仅因为成功启动就认定隔离有效。

没有复制 cockpit-tools 源码文件；按研究机制与官方协议独立实现。第三方运行库依各自许可证使用，版本固定在 package-lock.json。
