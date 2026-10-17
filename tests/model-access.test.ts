import { expect, it } from "vitest";
import {
  modelAccess,
  supportsModel,
  MODEL_ACCESS_TTL,
  denyModel,
} from "../src/shared/model-access";
import { pickAccount, nextWake } from "../src/core/quota";
import type { Account } from "../src/shared/types";
const now = 1800000000000;
const account = (id: string, models: any[], complete = true): Account => ({
  id,
  identity: id,
  label: id,
  email: id,
  plan: "plus",
  enabled: true,
  status: "ready",
  blockedUntil: null,
  failureCount: 0,
  quotas: {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: now + 18000000,
      },
      secondary: null,
      reached: false,
      observedAt: now,
    },
  },
  modelAccess: modelAccess(models, now, complete),
});
it("allows an unlisted model when no account lists it and expires actual per-model denials", () => {
  const a = account("a", [{ id: "other" }]);
  expect(pickAccount([a], 0, "codex", now, "smart", "custom")?.account.id).toBe(
    "a",
  );
  denyModel(a, "custom", now);
  expect(supportsModel(a, "custom", now)).toBe(false);
  expect(supportsModel(a, "other", now)).toBe(true);
  expect(supportsModel(a, "custom", now + MODEL_ACCESS_TTL)).toBeUndefined();
  expect(supportsModel(a, "custom", now - 1)).toBeUndefined();
  expect(pickAccount([a], 0, "codex", now, "smart", "custom")).toBeNull();
});
it("accepts listed IDs, aliases and hidden entries without treating availability introductions as denial", () => {
  const a = account("a", [
    {
      id: "alias",
      model: "engine",
      hidden: true,
      availabilityNux: { message: "Try this model" },
    },
  ]);
  expect(supportsModel(a, "alias", now)).toBe(true);
  expect(supportsModel(a, "engine", now)).toBe(true);
  expect(supportsModel(a, "missing", now)).toBeUndefined();
  expect(supportsModel(a, "", now)).toBe(true);
});
it("keeps empty, partial, old, future and malformed model evidence unknown", () => {
  const partial = account("p", [{ id: "listed" }], false);
  expect(supportsModel(partial, "unlisted", now)).toBeUndefined();
  expect(supportsModel(partial, "listed", now)).toBe(true);
  expect(supportsModel(account("empty", []), "wanted", now)).toBeUndefined();
  const old = account("old", [{ id: "listed" }]);
  expect(supportsModel(old, "wanted", now + MODEL_ACCESS_TTL)).toBeUndefined();
  expect(supportsModel(old, "wanted", now - 1)).toBeUndefined();
  for (const data of [
    { ids: null, observedAt: now, complete: true },
    { ids: [null], observedAt: now, complete: true },
    { ids: [], observedAt: NaN, complete: true },
  ])
    expect(
      supportsModel({ ...old, modelAccess: data } as any, "wanted", now),
    ).toBeUndefined();
});
it("applies model compatibility before either account selection policy and quota wake calculation", () => {
  const a = account("a", [{ model: "other" }]),
    b = account("b", [{ id: "wanted-alias", model: "wanted" }]);
  a.expiresAt = now + 3600000;
  for (const policy of ["smart", "roundRobin"] as const)
    expect(
      pickAccount([a, b], 0, "codex", now, policy, "wanted-alias")?.account.id,
    ).toBe("b");
  a.modelDenials = { wanted: now };
  b.quotas.codex.primary!.usedPercent = 100;
  b.quotas.codex.primary!.resetsAt = now + 300000;
  expect(pickAccount([a, b], 0, "codex", now, "smart", "wanted")).toBeNull();
  expect(nextWake([a, b], "codex", now, 60000, "wanted")).toBe(now + 302000);
});
