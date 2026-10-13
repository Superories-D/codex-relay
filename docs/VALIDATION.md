# 验证记录

环境：Linux x64，Node.js 24，2026-10-13。没有使用真实账户凭据，没有触发计费任务。

## 已执行

- 运行依赖 `npm audit --omit=dev` 为 0 项已知漏洞。审计发现 ws 旧版本问题，已升级固定到 8.22.0，随后重新构建并跑完测试。
- TypeScript strict 类型检查和 esbuild 主进程/preload/React 打包。
- Vitest 51 项检查，覆盖额度窗口、稀疏通知、重置时间、循环账户、同一会话续接、停止 ACK 与终止确认区别、停止超时冻结、全账户耗尽等待、手动暂停优先级、客户端 rollout 终止、崩溃占用标记、JSONL 半行/UTF-8、数据损坏和参数验证。
- 对安装版官方 `@openai/codex@0.162.1` 执行匿名 app-server initialize、account/read、model/list；获得真实协议响应。
- 生成并查看此版本官方 TypeScript 协议。实际探针发现 UI 内部 sandbox 枚举与线格式不同，已改为 `workspace-write/read-only/danger-full-access` 并增加回归检查；文本输入显式附带 `text_elements: []`。
- 本环境的匿名 `thread/start` 等待超过探针 30 秒期限，因此没有把实际线程创建/archive/resume 声称为通过。线程逻辑通过适配器测试与官方源码审查验证，真实会话端到端仍待 Windows 验收。
- 在独立无账户的 Chromium 中渲染实际构建后的界面，使用合成账户/任务数据检查工作台、新建任务、设置；三个截图对应本仓库的实际 React 页面。页面无 JavaScript 错误，1440px 检查无横向溢出。Linux 渲染检查额外加载了 Noto Sans SC，生产 Windows 使用系统字体。
- 人工审查 PowerShell 参数传递、Store 包启动、受管 PID/路径/profile 校验、ACL 和凭据写回顺序。已提供 Windows CI 的 PowerShell AST 解析检查，但没有在当前环境执行 Windows 脚本。

## 尚未验证

Windows 安装包运行、DPAPI 真机行为、浏览器/设备码真实登录、真实账户切号后继续执行、真实额度耗尽、客户端 DOM 选择器与受管配置隔离、Windows 沙盒安装及休眠恢复。

这些项目必须依照 `WINDOWS-ACCEPTANCE.md` 进行验收。客户端适配标记为实验功能；不能将 mock 测试和界面渲染等同于完整产品真机验证。

## 复现

```powershell
npm ci
npm run check
npm run package:win
```

测试不调用真实 OpenAI 服务，不需要密钥。`.github/workflows/windows.yml` 在 Windows 上执行相同检查并生成安装包；本次没有宣称该远程工作流已运行。
