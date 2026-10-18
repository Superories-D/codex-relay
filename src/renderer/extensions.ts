type Operation = (
  method: string,
  params: Record<string, unknown>,
) => Promise<any>;

export async function readExtensions(
  tab: string,
  cwd: string,
  operation: Operation,
) {
  if (tab === "skills")
    return operation("skills/list", {
      cwds: cwd ? [cwd] : [],
      forceReload: true,
    });
  if (tab !== "mcp")
    return operation("plugin/list", { cwds: cwd ? [cwd] : [] });
  const data: any[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await operation("mcpServerStatus/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    data.push(...page.data);
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("工具列表分页异常，请刷新后重试");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const config = await operation("config/read", { includeLayers: false });
  const servers = config.config?.mcp_servers || {};
  return {
    data: data.map((entry) => ({
      ...entry,
      enabled: servers[entry.name]?.enabled !== false,
      manageable:
        !entry.pluginId &&
        Object.hasOwn(servers, entry.name) &&
        /^[\w-]+$/.test(entry.name),
    })),
  };
}
