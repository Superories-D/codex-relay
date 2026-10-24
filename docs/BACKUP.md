# 服务器离线加密备份

Linux 服务器停止后使用打包内的 `dist/server/backup.cjs`。备份包含数据目录内的账号保险库及主密钥、原生运行历史、任务、附件、Telegram 状态、定时计划和操作回执；**不包含数据目录以外的项目代码**，项目应另行用 Git 或文件备份保存。

先生成并单独保管密码文件（丢失后无法恢复）：

```sh
node -e 'require("node:fs").writeFileSync("backup-password",require("node:crypto").randomBytes(32).toString("base64"),{flag:"wx",mode:0o600})'
node dist/server/backup.cjs create --data-dir /private/relay-data --file /backups/relay.crb --password-file ./backup-password
node dist/server/backup.cjs verify --file /backups/relay.crb --password-file ./backup-password
```

输出文件必须在数据目录之外，并且尚不存在。备份程序取得与服务相同的内核所有权锁；正在运行的服务、未完成进程恢复的状态都会拒绝备份。使用 scrypt 派生密钥、AES-256-GCM 认证加密，压缩内容含逐文件 SHA-256 与整体清单摘要。输出和密码文件须为当前用户私有；密码不接受命令行明文参数。

## 恢复

先停止服务。原数据目录必须不存在；如仍存在，先自行移到旁边保留。恢复路径必须与备份中的原绝对路径相同，避免原生历史、工作树和附件引用失效：

```sh
node dist/server/backup.cjs restore --data-dir /private/relay-data --file /backups/relay.crb --password-file ./backup-password
node dist/server/main.cjs --data-dir /private/relay-data --check
```

恢复先写入私有临时目录，密码认证、清单和校验和全部通过后才发布；不会合并或覆盖已有数据。错误密码、内容篡改、重复/越界路径和残缺清单会失败并清理暂存目录。验证命令只解密检查，不恢复文件。

限制：当前最多 10,000 个条目、单文件 64 MiB、总原始文件 512 MiB。超过限制会明确失败，不生成部分可用备份。拒绝硬链接、特殊文件和符号链接；只忽略锁/套接字及运行时 skills/plugins 的外部目录链接（这些链接由运行时按当前配置重建），忽略清单会显示在结果里。恢复保留用户可执行位，文件收紧为 0600/0700，目录为 0700。外部插件、项目、CLI 二进制和服务部署配置须另行保管。

新版 Codex CLI 在 runtime/jobs/<任务 ID>/.tmp/plugins 下载的临时插件目录也会排除，并列入备份的排除清单。该目录由 CLI 重新下载；其他 .tmp 内容、实际安装的 skills/plugins 目录和会话历史仍保留。
