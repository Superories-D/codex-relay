# Windows 本机调试记录（2026-10-17）

后续真实账户 CLI 测试已经完成，结果见 [CLI 真实账户验收](LIVE-CLI-20261017.md)。本文“未登录真实账户”等描述仅指此前的构建调试阶段。

基于提交 `ebc1aae`，Windows x64、Node.js 24.13.0、Electron 44.7.0。修复保留在本地工作区，未推送远程仓库。

## 已修复

- 宿主 PowerShell 的 `PSModulePath` 导致 Windows PowerShell 5.1 加载不兼容模块，启动时无法使用 `Set-Acl`。所有 Windows PowerShell 子进程现在移除继承的模块路径，让系统重建默认路径。
- `Set-Acl` 重复初始化受保护目录时申请 `SeSecurityPrivilege`。改用 .NET `Directory.SetAccessControl` 仅保存已修改的所有者和 DACL；仍仅允许当前用户与 SYSTEM，仍禁用继承。
- MSIX 宿主把 AppData 重定向到另一磁盘，逻辑路径下的原子重命名返回 `EXDEV`。创建临时文件前解析父目录真实路径，再在同一真实目录内原子替换。没有降级为非原子覆盖。
- 路径越界测试需要 Windows 文件符号链接权限。Windows 改用不要求该权限的目录联接，保留真实路径越界校验；其他平台继续测试文件符号链接。

## 验证

- TypeScript 类型检查与主进程、preload、React 构建通过。
- Vitest：19 个测试文件、150 项全部通过，包括真实 AppData 新建/覆盖与连续两次目录权限初始化。
- 全部 Windows 辅助脚本通过 Windows PowerShell 5.1 语法解析。
- 原有浏览器 UI 回归通过：五个页面、三种窗口宽度、弹窗和异步操作，无横向溢出或 JavaScript 错误。
- 原有 Desktop 控件适配回归通过：线程识别、发送/停止保护、中文输入和草稿保留；使用合成页面。
- 实际 `release/win-unpacked/Codex Relay.exe` 启动通过：五个页面导航、真实 DPAPI 加解密、真实命名管道 CLI 查询、正常退出。
- 实际程序截图：`qa-output/windows-packaged.png`；机器可读结果：`qa-output/windows-smoke.json`。
- 最终便携版 `release/Codex-Relay-Portable-0.4.0-x64.exe` 自解压启动、命名管道和环境检查通过，测试后正常退出。便携启动器不适用 Playwright 的 `_electron.launch` 握手，最终使用浏览器 CDP 检查实际窗口。结果见 `qa-output/portable-smoke.json`。
- 官方 CLI `0.162.1` 安装在 `runtime/cli/`，本机程序设置已保存其原生 `codex.exe` 路径；Windows PowerShell `5.1.26100.9444` 检查通过。
- 安装版与便携版均已生成；SHA-256 位于 `release/checksums.json`。未执行安装向导或修改系统安装目录。

## 使用产物

直接运行 `release/Codex-Relay-Portable-0.4.0-x64.exe`，或使用 `release/Codex-Relay-Setup-0.4.0-x64.exe` 安装。首次使用在“账户轮换”中添加自己的 ChatGPT 账户。

本机 CLI 位于 `runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`。如果移动项目、换电脑或从不同的宿主启动，需在“设置”中确认该路径并执行环境检查。构建产物本身包含 Electron，不要求另行安装 Electron；真实任务仍需要 Codex CLI。

未登录真实 OpenAI 账户、提交模型任务或消耗额度，因此真实账户轮换、额度耗尽和官方客户端任务交接仍需使用者验收。未配置代码签名证书；安装包为本机未签名构建。

## 在本机重新构建

普通环境按 README 使用 `npm ci`、`npm run check`、`npm run package:win`。

本机打包工具缓存也受到重定向影响，因此复用了已下载的 Electron，手动解压并校验了 NSIS 资源，并将 winCodeSign 工具包中的 macOS 符号链接排除在 Windows 缓存之外。此次准备好的工具位于忽略提交的 `qa-output/`。在项目根目录运行：

```powershell
npm run check
$env:ELECTRON_BUILDER_CACHE = Join-Path (Get-Location) 'qa-output\builder-cache'
$env:ELECTRON_BUILDER_NSIS_DIR = Join-Path (Get-Location) 'qa-output\build-tools\nsis-3.0.4.1'
$env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = Join-Path (Get-Location) 'qa-output\build-tools\nsis-resources-3.4.1'
node node_modules/electron-builder/cli.js --win --x64 '--config.electronDist=node_modules/electron/dist'
```

此命令依赖本机已准备的工具目录；复制源码到另一台机器时先按常规构建步骤安装依赖。

实际程序检查（运行前退出其他 Relay 实例，只在没有待执行任务的环境运行）：

```powershell
$env:RELAY_PLAYWRIGHT_MODULE = Join-Path (Get-Location) 'qa-output\tools\node_modules\playwright'
node scripts/qa/windows.cjs
```

此检查使用程序正常的数据目录，不登录、不导入账户、不新建任务。
