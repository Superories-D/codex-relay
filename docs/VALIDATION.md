# 验证记录

环境：Linux x64，Node.js 24；初轮 2026-10-13，v0.1.1 / v0.2.0 深度调试 2026-10-14，v0.3.0 参考实现审查与 v0.4.0 已有会话接入回归 2026-10-15。测试没有使用真实 OpenAI 账户凭据，没有触发计费任务。

## 已执行

- v0.4.0 新增已有会话读写与交接回归：完整/增量长历史、旧额度证据重置、迟到额度事件、完整记录损坏、末尾 UTF-8 半行、路径依赖与身份验证、停止失败门禁、进程范围变化后重试、原进程消失、意外退出恢复、源文件重新写入、账户刷新排队竞争。
- 使用真实 Rpc/CliWorker/Scheduler 与合成 JSONL 子进程走通「已有 rollout → 原进程停止边界模拟 → 导入原 thread ID → 完成」。验证复制副本被恢复、原历史不变、提示包含原任务与重复操作检查。真实 CLI attach 通过本地协议执行扫描/检查/授权后接入，缺少 --allow-stop 不接入。
- 实际构建后的接入弹窗在 Chromium 检查扫描、候选选择、PID/路径范围、未授权按钮禁用、检查失败后重新选择、提交参数、监控状态及 860px 布局。没有调用 Windows 进程终止，也没有真实 Codex 账户参与。

- TypeScript strict 类型检查和 esbuild 主进程/preload/React 打包。
- Vitest **147 项、18 个文件全部通过**，涵盖额度窗口与重置时间、轮换与等待、手动暂停优先级、进程终止与异常恢复、凭据串行访问与失败保留、断连、CLI 命令认证以及 JSONL/UTF-8 边界。本版新增导入预览/部分失败/退出等待、完成标记/补完上限、运行中账户保护和环境诊断。详细证据见 [参考审查](REFERENCE-REVIEW.md)、[DEBUG-REVIEW.md](DEBUG-REVIEW.md) 和 [DEBUG-V020.md](DEBUG-V020.md)。
- 启动真正的 JSONL 测试子进程，运行实际 Rpc/CliWorker/Scheduler：额度错误后伪完成不终止任务，换号后续接相同线程，退出后释放占用记录。
- 启动真实 CLI 查看器与本地命令服务器，检查认证、状态通知、监听清理和失联非零退出。Linux 环境 AF_UNIX 返回 EPERM，测试专用 TCP 适配器验证协议；未把此项当作 Windows 命名管道实测。
- 真实 Chromium 上执行实际 Cdp 代码：线程完整路由识别（忽略查询参数中的引用 ID）、发送/停止前原子校验、用户草稿保护、重复填入幂等、textarea/contenteditable 中文多行输入、禁用按钮、多编辑器/页面拒绝。无真实账户与官方客户端参与。
- 模拟 Windows 外部边界、使用真实临时文件检查完整 Desktop 启动过程、首轮模型配置、发送前标记落盘、旧终止事件忽略、准备中暂停以及账户释放顺序。
- 对安装版官方 `@openai/codex@0.162.1` 执行匿名 app-server initialize、account/read、model/list；获得真实协议响应。生成对应 TypeScript 协议，并对照 `rust-v0.162.1` 源码。
- 官方匿名 `thread/start` 曾超过 30 秒和 120 秒探针期限；追加日志有插件网络初始化失败，尚不能确定超时根因。因此真实线程创建/archive/resume 和账户轮换端到端没有列为通过。
- 在独立 Chromium 中渲染实际构建后的 React 界面，使用合成账户/任务数据检查导入预览/选择、完成标记与补完次数提交、环境检查、Desktop 诊断、取消确认、异步账户操作期间打开新任务、冲突操作类型隔离、表单内错误、设置草稿保留与保存反馈、自动检测和暂停状态。五个页面在 860/1000/1440px 均无横向溢出，页面无 JavaScript 错误。Linux 检查加载 Noto Sans SC，Windows 使用系统字体。
- 人工复核 PowerShell 参数、Store 包启动、受管 PID/路径/profile、回执 nonce、ACL 与凭据写回顺序。已提供 Windows CI 的 PowerShell AST 检查，当前环境没有执行 Windows 脚本。
- 初轮 `npm audit --omit=dev` 为 0 项已知漏洞；修复了 ws 版本问题并固定到 8.22.0。本轮未改变运行依赖版本。

## 尚未验证

Windows Restart Manager 文件归属/创建时间核对、PowerShell 停止原进程树与回执恢复、普通客户端已有会话真实迁入、Windows 安装包运行、DPAPI 真机行为、命名管道、浏览器/设备码真实登录、真实账户切号、真实额度耗尽、官方客户端 DOM 与配置隔离、Windows 沙盒安装及休眠恢复。

按 [WINDOWS-ACCEPTANCE.md](WINDOWS-ACCEPTANCE.md) 验收。客户端适配为实验功能；测试对端与 Chromium 适配检查不等同于完整产品真机验证。

## 复现

```powershell
npm ci
npm run check
npm run package:win
```

测试不需要密钥或真实 OpenAI 服务。Gitea 工作流位于 `.gitea/workflows/`，Windows 打包需手动运行并配备 Windows runner；另保留 GitHub 工作流。本次没有把工作流文件存在当成远程执行通过。

## 可选浏览器回归

```powershell
npm install --no-save playwright
npx playwright install chromium
npm run build
node scripts/qa/desktop.cjs
node scripts/qa/ui.cjs
```

界面脚本使用合成数据，输出在忽略提交的 `qa-output/`。可用 `RELAY_CHROMIUM_PATH` 指定现有 Chromium，`RELAY_PLAYWRIGHT_MODULE` 指定现有 Playwright 模块，`RELAY_QA_OUTPUT` 指定界面检查输出目录。它们是开发验证脚本，不随安装包分发。浏览器回归不需要真实账户，也不替代 Windows 真机验收。
