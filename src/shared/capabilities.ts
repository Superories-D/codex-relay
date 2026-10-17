// Versioned public app-server operations. Turn/account/process lifecycle remains
// exclusively owned by Scheduler; it cannot be bypassed by the command panel.
export const capabilities = [
  { method: "thread/compact/start", label: "压缩会话上下文", params: {} },
  {
    method: "thread/read",
    label: "读取完整会话",
    params: { includeTurns: true },
  },
  { method: "thread/turns/list", label: "分页读取轮次", params: { limit: 20 } },
  {
    method: "thread/items/list",
    label: "读取轮次项目",
    params: { turnId: "", limit: 50 },
  },
  { method: "thread/goal/get", label: "读取目标", params: {} },
  {
    method: "thread/goal/set",
    label: "设置目标",
    params: { objective: "", origin: "user" },
  },
  { method: "thread/goal/clear", label: "清除目标", params: {} },
  { method: "model/list", label: "模型与推理强度", params: { limit: 100 } },
  { method: "skills/list", label: "查看 Skills", params: {} },
  {
    method: "skills/config/write",
    label: "启用 / 禁用 Skill",
    params: { path: "", enabled: true },
  },
  {
    method: "mcpServerStatus/list",
    label: "MCP 服务器状态",
    params: { limit: 100 },
  },
  { method: "config/mcpServer/reload", label: "重载 MCP 配置", params: {} },
  { method: "mcpServer/oauth/login", label: "MCP 登录", params: { name: "" } },
  {
    method: "mcpServer/resource/read",
    label: "读取 MCP 资源",
    params: { server: "", uri: "" },
  },
  {
    method: "mcpServer/tool/call",
    label: "调用 MCP 工具",
    params: { server: "", tool: "", arguments: {} },
  },
  { method: "plugin/list", label: "插件目录", params: {} },
  { method: "plugin/installed", label: "已安装插件", params: {} },
  { method: "plugin/read", label: "插件详情", params: { pluginName: "" } },
  { method: "plugin/install", label: "安装插件", params: { pluginName: "" } },
  { method: "plugin/uninstall", label: "卸载插件", params: { pluginId: "" } },
  { method: "app/list", label: "查看应用", params: {} },
  { method: "app/installed", label: "已安装应用", params: {} },
  {
    method: "config/read",
    label: "读取 CLI 配置",
    params: { includeLayers: true },
  },
  {
    method: "config/value/write",
    label: "修改 CLI 配置",
    params: { keyPath: "", value: "", mergeStrategy: "replace" },
  },
  { method: "config/batchWrite", label: "批量修改配置", params: { edits: [] } },
  { method: "configRequirements/read", label: "组织配置约束", params: {} },
  {
    method: "experimentalFeature/list",
    label: "实验功能",
    params: { limit: 100 },
  },
  {
    method: "experimentalFeature/enablement/set",
    label: "切换实验功能",
    params: { enablement: {} },
  },
  { method: "permissionProfile/list", label: "权限配置", params: {} },
  { method: "hooks/list", label: "查看 Hooks", params: {} },
  { method: "gitDiffToRemote", label: "Git 变更", params: { cwd: "" } },
  {
    method: "command/exec",
    label: "执行命令",
    params: { command: ["git", "status", "--short"], timeoutMs: 10000 },
  },
] as const;
