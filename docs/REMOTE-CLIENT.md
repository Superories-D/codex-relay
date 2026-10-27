# Linux / Windows 远程客户端

需要 Node.js 24。客户端使用相同脚本连接 Linux 服务器；Windows 上无需运行 Linux 后台服务。服务器和客户端一起升级以使用安装身份绑定。

## 私有连接配置

```sh
node scripts/remote.cjs init
node scripts/remote.cjs profile save production --url http://127.0.0.1:7899 --token-file /private/http-token --cwd /srv/project --host user@server
node scripts/remote.cjs profile list
node scripts/remote-tunnel.cjs --profile production
node scripts/remote.cjs health --profile production
node scripts/remote.cjs run --profile production --prompt-file task.txt --detach
```

Windows PowerShell 也使用上述 Node 命令；`--token-file` 改为本机 Windows 路径，`--cwd` 始终是**服务器路径**。先运行 `init`，将令牌文件复制到它输出的 credentials 目录，再保存配置。该目录使用 Windows 当前用户 + SYSTEM 的继承 ACL；读取私有文件会验证 ACL，权限不安全时拒绝。Linux 使用 0700 目录、0600 文件及所有者校验。

默认位置为 Linux `$XDG_CONFIG_HOME/codex-relay/remote`（未设置时 `~/.config/...`），Windows `%APPDATA%/codex-relay/remote`；可用 `RELAY_REMOTE_HOME` 指向专用私有目录。配置保存令牌的私有副本，配置 JSON 不含令牌正文。`profile show NAME` 查看连接信息，`profile remove NAME` 删除配置；私有凭据和请求记录保留以免误删恢复数据。

SSH 配置可附带 `--local-port`、`--remote-port`、`--ssh-port`；先用 `node scripts/remote-tunnel.cjs --profile production --check` 检查命令。它使用本机 OpenSSH、严格主机密钥校验和仅监听 127.0.0.1 的转发。若更改 local-port，请同步 profile 的 `--url` 端口。未验证的主机密钥不会自动接受。

## 中断后的请求恢复

任务、追问、工作流以及支持持久回执的远程操作，在 POST 前保存原始请求、请求编号、服务器安装 UUID 和端点。客户端被强制结束后：

```sh
node scripts/remote.cjs requests
node scripts/remote.cjs recover --profile production --request-id REQUEST_UUID
```

恢复使用原参数和编号，不重新生成任务。已确认请求直接返回保存的结果；服务器安装身份或端点不匹配会拒绝恢复，包括 SSH 相同端口后来连到另一台服务器。换机恢复同一备份会保留安装身份。

`command --file command.json --profile production` 可调用白名单 API；任务输入、Goal、定时操作等有回执的命令会自动保存请求。普通暂停/取消和审批等未声明幂等性的命令不会盲目重放。原生执行结果未知时，服务器返回 pending/uncertain 回执，客户端也不会把它变成第二次原生操作。

客户端普通网络重试采用有限退避；最终仍失败时请求留在本地，使用 recover 继续确认。状态 watch 独立自动重连，Ctrl+C 只关闭查看器。禁止 HTTP 跨机器明文端点、URL 内凭据和 HTTP 重定向。请求箱可能包含任务内容，请按私有数据保管。

本轮已在 Linux 实测客户端进程被杀后的恢复与服务端去重。Windows ACL 和客户端测试已纳入现有 Windows CI，本次环境未运行原生 Windows 验收。

HTTP 4xx 会结束本次尝试并显示错误，但不会抹掉或永久封死本地请求：服务器或中间代理可能在提交已经生效后返回错误。排查连接、权限或服务器状态后可用 `recover` 重用同一编号；无效参数也不会被自动反复发送。旧版误记为 rejected 的可靠请求也可通过显式 `recover` 重新核对，仍会校验服务器安装身份。

网页也会把当前标签页绑定到首次验证的服务器安装 UUID，命令、文件和状态订阅附带安装标识；服务器在处理请求前校验，防止 SSH 同端口换目标后误投。服务器身份改变时请在新标签页连接，新页面不携带旧页待确认数据。网页“断开连接”仅清除连接令牌，保留草稿、附件与待确认请求，便于换令牌后继续核对。

网页新建任务和追问会保存服务器标识与原请求编号。连接有效时，未确认提交在 2–30 秒退避后自动重试；刷新、断开后重新登录也可恢复，追问无需重新选中任务。单请求并发锁防止手动和自动重试重叠。鉴权失败保留请求，换令牌后继续；不带安装标识的旧版待确认记录仍需用户显式重试。
