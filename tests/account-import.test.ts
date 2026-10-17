import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountImport, parseImport } from "../src/core/account-import";
import { Store } from "../src/core/store";
const token = (value: unknown) =>
  "e30." +
  Buffer.from(JSON.stringify(value)).toString("base64url") +
  ".synthetic";
const auth = (id = "a") => ({
  tokens: {
    access_token: "private-access-" + id,
    refresh_token: "private-refresh-" + id,
    id_token: token({ email: id + "@example.test" }),
    account_id: id,
  },
});
const services: AccountImport[] = [];
function setup() {
  const store = new Store("/unused");
  const accounts = { import: vi.fn(async () => ({})) };
  const service = new AccountImport(accounts as any, store);
  services.push(service);
  return { store, accounts, service };
}
afterEach(() => {
  services.forEach((s) => s.cancel());
  services.length = 0;
  vi.useRealTimers();
});
describe("account backup normalization", () => {
  it("does not deduplicate different users of one Team workspace", () => {
    const team = (user: string) => ({
      tokens: {
        ...auth("same-team").tokens,
        id_token: token({ sub: user, email: `${user}@example.test` }),
      },
    });
    const rows = parseImport(
      JSON.stringify([team("one"), team("two"), team("one")]),
    );
    expect(rows.map((r) => !!r.auth)).toEqual([true, true, false]);
    expect(rows[1].identity).toBe(rows[0].identity);
    expect(rows[1].userIdentity).not.toBe(rows[0].userIdentity);
  });
  it("accepts official, flat CodexPilot, credentials and BOM JSONL formats", () => {
    const a = auth();
    expect(parseImport(JSON.stringify(a))[0].auth?.auth_mode).toBe("chatgpt");
    expect(
      parseImport(
        JSON.stringify({ accounts: [{ ...a.tokens, label: "From Pilot" }] }),
      )[0].label,
    ).toBe("From Pilot");
    expect(
      parseImport(JSON.stringify({ accounts: [{ credentials: a.tokens }] }))[0]
        .identity,
    ).toBe("a");
    expect(
      parseImport(
        "\uFEFF" + JSON.stringify(auth("a")) + "\n" + JSON.stringify(auth("b")),
      ),
    ).toHaveLength(2);
  });
  it("rejects API keys and conflicting identities while preserving valid siblings", () => {
    const rows = parseImport(
      JSON.stringify([
        auth(),
        { api_key: "do-not-copy" },
        { ...auth("b"), account_id: "c" },
        null,
      ]),
    );
    expect(rows[0].auth).toBeDefined();
    expect(rows.slice(1).every((r) => r.error && !r.auth)).toBe(true);
  });
  it("skips duplicate and deleted accounts instead of silently importing stale credentials", () => {
    const rows = parseImport(
      JSON.stringify([auth(), auth(), { ...auth("b"), status: "deleted" }]),
    );
    expect(rows.filter((r) => r.auth)).toHaveLength(1);
    expect(rows[1].duplicate).toBe(true);
  });
  it("does not include credential fragments in malformed JSON errors", () => {
    const rows = parseImport('{"access_token":"do-not-leak"\nnot-json');
    expect(rows.every((r) => r.error)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("do-not-leak");
  });
  it("limits both file bytes and row count", () => {
    expect(() => parseImport("x".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
    expect(() => parseImport(JSON.stringify(Array(201).fill(auth())))).toThrow(
      "200",
    );
  });
});
describe("main-process import preview", () => {
  it("never exposes tokens and marks existing identities for update", () => {
    const { service, store } = setup();
    store.data.accounts = [
      { identity: "a", userIdentity: "a@example.test" } as any,
    ];
    const preview = service.preview(JSON.stringify([auth("a"), auth("b")]));
    expect(preview.rows.map((r) => r.action)).toEqual(["update", "add"]);
    expect(JSON.stringify(preview)).not.toMatch(
      /private-access|private-refresh|access_token|refresh_token|id_token/,
    );
  });
  it("only imports selected valid rows, reports per-row errors, and consumes the handle once", async () => {
    const { service, accounts } = setup();
    const preview = service.preview(
      JSON.stringify([auth("a"), auth("b"), auth("c")]),
    );
    accounts.import.mockRejectedValueOnce(new Error("account busy"));
    const result = await service.commit(preview.id, [0, 2]);
    expect(result.imported).toBe(1);
    expect(result.results.map((r) => r.ok)).toEqual([false, true]);
    expect(accounts.import).toHaveBeenCalledTimes(2);
    expect(accounts.import.mock.calls.flat().join()).not.toContain(
      "private-access-b",
    );
    await expect(service.commit(preview.id, [0])).rejects.toThrow("失效");
  });
  it("rejects expired, cancelled, duplicate, and invalid selection handles", async () => {
    const { service, accounts } = setup();
    let p = service.preview(JSON.stringify(auth()));
    await expect(service.commit(p.id, [0, 0])).rejects.toThrow("有效");
    await expect(service.commit(p.id, [99])).rejects.toThrow("有效");
    service.cancel(p.id);
    await expect(service.commit(p.id, [0])).rejects.toThrow("失效");
    p = service.preview(JSON.stringify(auth()), Date.now() - 11 * 60_000);
    await expect(service.commit(p.id, [0])).rejects.toThrow("失效");
    expect(accounts.import).not.toHaveBeenCalled();
  });
  it("prevents a second import from replacing an in-progress batch", async () => {
    const { service, accounts } = setup();
    let release!: () => void;
    accounts.import.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({});
        }),
    );
    const preview = service.preview(JSON.stringify(auth()));
    const committing = service.commit(preview.id, [0]);
    expect(() => service.preview(JSON.stringify(auth("b")))).toThrow(
      "仍在进行",
    );
    release();
    await committing;
  });
  it("drains the entire batch before shutdown, including later account writes", async () => {
    const { service, accounts } = setup();
    const releases: (() => void)[] = [];
    accounts.import.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({}));
        }),
    );
    const preview = service.preview(JSON.stringify([auth("a"), auth("b")]));
    const committing = service.commit(preview.id, [0, 1]);
    let drained = false;
    const draining = service.drain().then(() => {
      drained = true;
    });
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(drained).toBe(false);
    releases[1]();
    expect((await committing).imported).toBe(2);
    await draining;
    expect(drained).toBe(true);
  });
});
