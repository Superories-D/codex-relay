# 交付与后续推送

仓库建议名：`codex-relay`，可见性必须设为 **Private**。

GitHub 连接能识别用户，但当前暴露的能力没有“创建仓库”；此前备用网页停在登录页。没有创建远程仓库，也没有推送到已有仓库。按用户允许的备用方案，先保存完整源码。

v0.2.0 ZIP 为当前版本的完整源码快照，包含构建配置、Windows CI、测试、浏览器回归脚本和说明文档。本地项目保留原提交历史；本版快照不包含 Git 元数据、QA 截图、node_modules、真实 auth.json、账户库或安装包。

后续在已登录 GitHub CLI 的环境中，解压并进入源码目录：

```powershell
git init -b main
git add .
git commit -m "Import Codex Relay v0.2.0"
gh repo create codex-relay --private --source . --remote origin --push
```

如果是在现有本地 Git 项目目录继续工作，跳过前三步。也可以在 GitHub 创建私有空仓库后执行 `git remote add origin <仓库 Git URL>` 和 `git push -u origin main`。按 README 在 Windows 构建与验收。
