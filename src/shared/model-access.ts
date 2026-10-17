import type { Account, ModelAccess } from "./types";

export const MODEL_ACCESS_TTL = 120000;
export function modelAccess(
  models: any[],
  observedAt: number,
  complete: boolean,
): ModelAccess {
  const ids = [
    ...new Set(
      models
        .flatMap((model) => [model?.id, model?.model])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  // An empty or truncated directory is not proof that an account has no models.
  return { ids, observedAt, complete: complete && ids.length > 0 };
}
export function freshModelAccess(account: Account, now = Date.now()) {
  const access = account.modelAccess;
  return (
    !!access &&
    Array.isArray(access.ids) &&
    access.ids.every((id) => typeof id === "string") &&
    typeof access.complete === "boolean" &&
    Number.isFinite(access.observedAt) &&
    access.observedAt <= now &&
    now - access.observedAt < MODEL_ACCESS_TTL
  );
}
export function supportsModel(
  account: Account,
  model?: string,
  now = Date.now(),
): boolean | undefined {
  if (!model) return true;
  const denial = account.modelDenials?.[model];
  if (
    typeof denial === "number" &&
    Number.isFinite(denial) &&
    denial <= now &&
    now - denial < MODEL_ACCESS_TTL
  )
    return false;
  if (!freshModelAccess(account, now)) return;
  const access = account.modelAccess!;
  if (access.ids.includes(model)) return true;
}
// Directory membership guides routing; absence is never a permission denial.
export function modelRank(account: Account, model?: string, now = Date.now()) {
  if (!model) return 1;
  if (!freshModelAccess(account, now)) return 1;
  if (account.modelAccess!.ids.includes(model)) return 2;
  return account.modelAccess!.complete ? 0 : 1;
}
export function denyModel(account: Account, model: string, now = Date.now()) {
  account.modelDenials = {
    ...Object.fromEntries(
      Object.entries(account.modelDenials || {}).filter(
        ([, at]) =>
          Number.isFinite(at) && at <= now && now - at < MODEL_ACCESS_TTL,
      ),
    ),
    [model]: now,
  };
}
