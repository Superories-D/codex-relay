import { t, useI18n } from "./i18n";
export function operationKey(name: string, args?: unknown) {
  const a = args as any;
  if (
    ["account.import", "account.importLocal", "account.importCommit"].includes(
      name,
    )
  )
    return "account.importFlow";
  if (name === "job.control") return `job:${a?.id}`;
  if (name === "session.handoff") return `job:${args}`;
  if (["account.refresh", "account.models", "account.remove"].includes(name))
    return `account:${args}`;
  if (name === "account.update") return `account:${a?.id}`;
  return name;
}
export function operationLabel(name: string) {
  return (
    (
      {
        "job.add": t("正在创建任务"),
        "session.scan": t("正在读取本机会话"),
        "session.inspect": t("正在核实原进程"),
        "session.attach": t("正在接入已有会话"),
        "session.handoff": t("正在交接原会话"),
        "job.control": t("正在处理任务状态"),
        "account.login": t("正在打开官方登录"),
        "account.refresh": t("正在核实账户额度"),
        "account.models": t("正在读取模型"),
        "account.import": t("正在读取导入预览"),
        "account.importLocal": t("正在读取本机登录"),
        "account.importCommit": t("正在保存导入账户"),
        "environment.check": t("正在检查运行环境"),
        "desktop.detect": t("正在检测客户端安装"),
        "job.desktop.inspect": t("正在检查受管客户端"),
        "job.desktop.show": t("正在打开客户端窗口"),
        "settings.save": t("正在保存设置"),
      } as Record<string, string>
    )[name] ?? t("正在处理操作")
  );
}
