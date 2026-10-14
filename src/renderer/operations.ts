export function operationKey(name: string, args?: unknown) {
  const a = args as any;
  if (name === "job.control") return `job:${a?.id}`;
  if (["account.refresh", "account.models", "account.remove"].includes(name))
    return `account:${args}`;
  if (name === "account.update") return `account:${a?.id}`;
  return name;
}
export function operationLabel(name: string) {
  return (
    (
      {
        "job.add": "正在创建任务",
        "job.control": "正在处理任务状态",
        "account.login": "正在打开官方登录",
        "account.refresh": "正在核实账户额度",
        "account.models": "正在读取模型",
        "account.import": "正在导入账户",
        "desktop.detect": "正在检测客户端安装",
        "job.desktop.inspect": "正在检查受管客户端",
        "job.desktop.show": "正在打开客户端窗口",
        "settings.save": "正在保存设置",
      } as Record<string, string>
    )[name] ?? "正在处理操作"
  );
}
