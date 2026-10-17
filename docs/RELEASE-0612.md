# v0.6.12 Windows 安装启动修复

用户在 `D:\codex-relay\Codex Relay` 安装 v0.6.11 后，连续遇到权限初始化失败和 `ipc-token` 的 `EXDEV`。此前便携版、空 QA profile 的启动通过，没有覆盖既有全局 AppData 与 MSIX 重定向同时存在的安装场景；v0.6.11 的验证范围不够。

## 权限初始化超时

旧脚本每次启动都会重写继承 DACL，即使目录已有正确权限，也会传播到缓存和历史文件。用户目录的原脚本实测 16120 ms；按原启动参数执行时，15067 ms 被 15 秒超时强制终止，`stdout/stderr` 为空，与截图吻合。

新脚本检查 owner、继承保护、两条精确的用户/SYSTEM FullControl ACE、继承及传播标志。完全匹配时不重写；多余的公开 ACE 仍会修复，没有绕过权限配置。相同用户目录的新脚本实测 2088 ms。

首次实际修改的时限改为 60 秒，并提供明确的目录、失败原因/超时提示；PowerShell 错误输出使用 UTF-8。

## 混合 AppData 视图的原子写入

目录 `realpath` 仍可能是 C 盘的全局目录，新建临时文件却重定向到 D 盘的 MSIX LocalCache；仅在创建前解析目录无法保证重命名同盘。

新写入流程在临时文件写完、同步并关闭后，解析该文件本身的真实路径，在它的物理目录中原子替换目标。不会以复制覆盖或截断旧文件作为降级方案；替换失败保留旧值并清理临时文件。

`scripts/qa/appdata-atomic.cjs` 使用默认既有 `Codex Relay` 数据目录中的随机 QA 文件，实测 v0.6.11 提交 `e316763` 的原函数返回 `EXDEV`；新函数的首次创建、再次替换及通过原始逻辑路径读取均通过。只删除这两个随机探针文件，没有读取/覆盖真实 token、账户库或状态文件。实际物理目录确认启用继承保护，只允许当前用户和 SYSTEM FullControl。

## 验证与安装

`npm run build` 和 36 个文件的 311 项测试通过。新增覆盖重定向临时文件的物理目录替换、拒绝替换时保留旧文件、真实 DACL 修复多余公开权限，以及明确的启动失败诊断。

源码修复提交 `d613d79` 已推送。已安装脚本修改前备份到独立 QA 目录，实际升级前又备份原 EXE 与 app.asar。本轮仅处理启动问题，持续功能 Goal 保持暂停。

实际运行最终 NSIS 安装包 `/S /D=D:\codex-relay\Codex Relay`，退出码 0，原目录从 `0.6.11.0` 升级到 `0.6.12.0`。安装后的 app.asar 与本次构建 SHA256 相同，权限脚本与修复源码相同。

`scripts/qa/installed-startup.cjs` 使用真正安装的 `D:\codex-relay\Codex Relay\Codex Relay.exe` 和默认既有 `C:\Users\antho\AppData\Roaming\Codex Relay`，不指定临时数据目录，连续冷启动两次：4558 ms、4615 ms。两次均验证原有设置值可保存、状态可读和 CLI 命名管道连接；应用版本 `0.6.12`、Electron `isPackaged=true`、界面错误 0。测试开始前确认该 profile 的账户数为 0 且没有待执行任务，模型调用 0。

最终自解压便携 EXE 的启动、命名管道、Codex CLI `0.162.1` 和 Windows PowerShell `5.1.26100.9711` 检查也通过。

## 产物

位于 `release/desktop-0.6.12/`，两个 EXE 的产品版本均为 `0.6.12`，签名状态为 `NotSigned`。

| 文件                                  |      字节 | SHA256                                                             |
| ------------------------------------- | --------: | ------------------------------------------------------------------ |
| `Codex-Relay-Portable-0.6.12-x64.exe` | 124898728 | `53DFE2284518D6646FB4E321FCC558AC67A1D2B0964606342C589CAE51F0A281` |
| `Codex-Relay-Setup-0.6.12-x64.exe`    | 125128547 | `6034AD19A1488CEE62ADDE722B66C6E36DE776631880766AFB6E7A01F232C4CE` |

完整本地记录：`qa-output/installed-upgrade-0.6.12-report.json`、`qa-output/installed-startup-report.json`、`qa-output/appdata-atomic-report.json`、`qa-output/portable-smoke.json`。二进制、应用备份和私人 QA 数据不提交到 Git。
