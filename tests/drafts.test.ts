import { expect, it } from "vitest";
import {
  loadDraftState,
  saveDraftState,
  remainingDraft,
  remainingFiles,
} from "../src/renderer/drafts";
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
it("migrates old text drafts and isolates a new chat by project", () => {
  const s = storage();
  s.setItem("relay.project", "/project");
  s.setItem(
    "relay.drafts",
    JSON.stringify({ new: "project draft", chat: "saved" }),
  );
  expect(loadDraftState(s).drafts).toEqual({
    "new:/project": "project draft",
    chat: "saved",
  });
});
it("restores text and attachment-only drafts together", () => {
  const s = storage();
  const state = {
    drafts: { chat: "日本語中文" },
    files: {
      other: [
        { type: "mention" as const, path: "/notes.txt", name: "notes.txt" },
      ],
    },
  };
  saveDraftState(s, state);
  expect(loadDraftState(s)).toEqual(state);
  saveDraftState(s, { drafts: {}, files: {} });
  expect(loadDraftState(s)).toEqual({ drafts: {}, files: {} });
});
it("discards malformed local data without crashing", () => {
  const s = storage();
  s.setItem("relay.composer.v2", "{broken");
  expect(loadDraftState(s)).toEqual({ drafts: {}, files: {} });
  s.setItem(
    "relay.composer.v2",
    JSON.stringify({
      version: 2,
      drafts: { chat: 2 },
      files: {
        chat: [
          null,
          { type: "remoteImage", path: "https://invalid", name: "x" },
        ],
      },
    }),
  );
  expect(loadDraftState(s)).toEqual({ drafts: {}, files: { chat: [] } });
});
it("keeps text and new attachments typed while an older send is awaiting acknowledgement", () => {
  const old = { type: "mention" as const, path: "/old", name: "old" };
  const next = { type: "mention" as const, path: "/new", name: "new" };
  expect(remainingDraft("next idea", "sent idea")).toBe("next idea");
  expect(remainingDraft("sent idea", "sent idea")).toBe("");
  expect(remainingFiles([old, next], [old])).toEqual([next]);
});
it("reports failed storage instead of claiming the draft was saved", () => {
  expect(() =>
    saveDraftState(
      {
        setItem() {
          throw Error("quota");
        },
      },
      { drafts: { chat: "keep" }, files: {} },
    ),
  ).toThrow("quota");
});
