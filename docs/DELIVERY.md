# v0.4.0 交付

用户指定的目标私有仓库：[Superories/codex-go](https://code.taiko.im/Superories/codex-go)，分支 `main`。产品名仍为 Codex Relay。v0.3.0 及更早提交历史保留，本版为完整源码交付。

仓库包含主程序、账户与任务状态机、CLI 入口、Windows Desktop 辅助脚本、Gitea/GitHub 工作流、自动化测试、浏览器回归脚本、构建和验收文档。没有提交用户提供的参考 ZIP、凭据、账户库、node_modules、QA 截图或安装包。

本版新增普通终端与普通官方客户端的已有本地主会话接入。UI 入口为右上角「接入已有会话」，也可使用 CLI `attach`；支持额度中断后交接或立即交接，详见 [操作指南](EXISTING-SESSIONS.md)。

## Windows 使用

```powershell
git clone https://code.taiko.im/Superories/codex-go.git
cd codex-go
npm ci
npm run check
npm run dev
```

Git 认证使用你本机的凭据管理器；不要把 token 写进远程 URL。安装官方 Codex CLI 并完成设置后使用；完整引导见 [README](../README.md)。

生成安装包执行 `npm run package:win`，输出到 `release/`。也可在 Gitea 手动运行 Windows 打包工作流；需要有 `windows-latest` runner，artifact 上传要求 Runner 3.x 的兼容配置。推送构建工作流同样依赖服务方可用的 Ubuntu runner，不能保证该实例已部署 runner。

## 验证范围

本地严格类型检查、构建、147 项测试、实际 Chromium 控件与 UI 回归通过。当前环境为 Linux，没有运行真实 Windows 安装包，没有进行真实账户额度耗尽、DPAPI、官方 Desktop 全链路验收；Desktop 保持实验适配标识。详细结果见 [VALIDATION.md](VALIDATION.md)，真机步骤见 [WINDOWS-ACCEPTANCE.md](WINDOWS-ACCEPTANCE.md)。
