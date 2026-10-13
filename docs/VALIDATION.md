# 验证记录

环境：Linux x64，Node.js 24；初轮 2026-10-13，v0.1.1 深度调试 2026-10-14。没有使用真实账户凭据，没有触发计费任务。

## 已执行

- TypeScript strict 类型检查和 esbuild 主进程/preload/React 打包。
- Vitest **81 项**检查，涵盖额度窗口与重置时间、轮换与等待、手动暂停优先级、进程终止与异常恢复、凭据串行访问与失败保留、断连、CLI 命令认证以及 JSONL/UTF-8 边界。详细修复证据见 [DEBUG-REVIEW.md](DEBUG-REVIEW.md)。
- 启动真正的 JSONL 测试子进程，运行实际 Rpc/CliWorker/Scheduler：额度错误后伪完成不终止任务，换号后续接相同线程，退出后释放占用记录。
- 启动真实 CLI 查看器与本地命令服务器，检查认证、状态通知、监听清理和失联非零退出。Linux 环境 AF_UNIX 返回 EPERM，测试专用 TCP 适配器验证协议；未把此项当作 Windows 命名管道实测。
- 真实 Chromium 上检查 Cdp 线程选中验证、中文多行输入、草稿保护、多编辑器/页面拒绝。无真实账户与官方客户端参与。
- 对安装版官方 `@openai/codex@0.162.1` 执行匿名 app-server initialize、account/read、model/list；获得真实协议响应。生成对应 TypeScript 协议，并对照 `rust-v0.162.1` 源码。
- 官方匿名 `thread/start` 曾超过 30 秒和 120 秒探针期限；追加日志有插件网络初始化失败，尚不能确定超时根因。因此真实线程创建/archive/resume 和账户轮换端到端没有列为通过。
- 在独立 Chromium 中渲染实际构建后的 React 界面，使用合成账户/任务数据查看工作台、新建任务、设置，更新仓库截图。页面无 JavaScript 错误，1440px 检查无横向溢出。Linux 检查加载 Noto Sans SC，Windows 使用系统字体。
- 人工复核 PowerShell 参数、Store 包启动、受管 PID/路径/profile、回执 nonce、ACL 与凭据写回顺序。已提供 Windows CI 的 PowerShell AST 检查，当前环境没有执行 Windows 脚本。
- 初轮 `npm audit --omit=dev` 为 0 项已知漏洞；修复了 ws 版本问题并固定到 8.22.0。本轮未改变运行依赖版本。

## 尚未验证

Windows 安装包运行、DPAPI 真机行为、命名管道、浏览器/设备码真实登录、真实账户切号、真实额度耗尽、官方客户端 DOM 与配置隔离、Windows 沙盒安装及休眠恢复。

按 [WINDOWS-ACCEPTANCE.md](WINDOWS-ACCEPTANCE.md) 验收。客户端适配为实验功能；测试对端与 Chromium 适配检查不等同于完整产品真机验证。

## 复现

```powershell
npm ci
npm run check
npm run package:win
```

测试不需要密钥或真实 OpenAI 服务。`.github/workflows/windows.yml` 在 Windows 执行检查并生成安装包；本次没有宣称该远程工作流已运行。
