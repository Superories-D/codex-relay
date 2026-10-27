const key = "relay.remote.serverId";
export const identityChanged = "服务器身份已变化，请在新标签页连接；本页保留原服务器的待确认请求。";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function bindServerIdentity(id: unknown, storage: Pick<Storage,"getItem"|"setItem"> = sessionStorage) {
  if (typeof id !== "string" || !uuid.test(id)) throw Error("服务器缺少安装标识，请更新服务器后重连。");
  const previous = storage.getItem(key);
  if (previous && previous !== id) throw Error(identityChanged);
  storage.setItem(key,id);
  return id;
}
export function serverHeaders(storage: Pick<Storage,"getItem"> = sessionStorage) {
  const id=storage.getItem(key);
  if (!id || !uuid.test(id)) throw Error("正在验证服务器身份，请稍后重试。");
  return {"X-Relay-Server-ID":id};
}
