import { expect, it } from "vitest";
import { reviewReport, verifyReviewSession, reviewableDiff, reviewNote, diffFingerprint, fileReviewed, nextReviewFile, readReviewSession, reviewKey, reviewStorageKey, updateReviewMark } from "../src/renderer/review-session";
it("requires both staged and working copies to be reviewed independently", () => {
  const file = { path: "file.ts", index: "M", worktree: "M" };
  const verified = new Set([reviewKey(file.path, true)]);
  expect(fileReviewed(file, verified)).toBe(false);
  verified.add(reviewKey(file.path, false));
  expect(fileReviewed(file, verified)).toBe(true);
  expect(fileReviewed({...file, path: "other.ts"}, verified)).toBe(false);
});
it("fingerprints actual diff bytes even when Git status has not changed", async () => {
  expect(await diffFingerprint("+first\n")).not.toBe(await diffFingerprint("+second\n"));
  expect(await diffFingerprint("+first\n")).toBe(await diffFingerprint("+first\n"));
});
it("persists bounded marks and private notes without code content", async () => {
  const mark = {key: reviewKey("a.ts", false), revision: "r1", fingerprint: await diffFingerprint("diff")};
  const saved = updateReviewMark({marks: [], notes: {"a.ts": "Check error handling"}}, mark, true);
  expect(readReviewSession(JSON.stringify(saved))).toEqual(saved);
  expect(updateReviewMark(saved, mark, false).marks).toEqual([]);
  expect(reviewStorageKey("C:/project-a")).not.toBe(reviewStorageKey("C:/project-b"));
  expect(readReviewSession('{"marks":[null,{}],"notes":[]}')).toEqual({marks: [], notes: {}});
  expect(readReviewSession("broken")).toEqual({marks: [], notes: {}});
});
it("wraps navigation and skips fully reviewed files without reselecting the current one", () => {
  const files = ["a", "b", "c"].map(path => ({path, index: " ", worktree: "M"}));
  const verified = new Set([reviewKey("b", false)]);
  expect(nextReviewFile(files, "a", verified, true)?.path).toBe("c");
  expect(nextReviewFile(files, "c", verified)?.path).toBe("a");
  expect(nextReviewFile([files[0]], "a", verified)).toBeUndefined();
  expect(nextReviewFile(files, "", verified)?.path).toBe("a");
});

it("does not certify a binary marker or inherited object member as review content", () => {
  expect(reviewableDiff("Binary file", {path: "a.png", index: "?", worktree: "?"})).toBe(false);
  expect(reviewableDiff("+new\n+text", {path: "a.txt", index: "?", worktree: "?"})).toBe(true);
  expect(reviewNote({marks: [], notes: {}}, "constructor")).toBe("");
});

it("revalidates same-status edited bytes, independent sides and failed reads before reporting", async () => {
  const file = {path: "a.ts", index: "M", worktree: "M"};
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const session = {notes: {}, marks: [true, false].map(staged => ({key: reviewKey(file.path, staged), revision: "same-status", fingerprint: ""}))};
  for (const mark of session.marks) mark.fingerprint = await diffFingerprint(diff);
  const state = {revision: "same-status", files: [file]};
  const result = await verifyReviewSession(session, state, async (_path, staged) => staged ? diff : diff.replace("+new", "+edited"));
  expect(result.verified).toEqual(new Set([reviewKey(file.path, true)]));
  expect(result.stale).toEqual(new Set([reviewKey(file.path, false)]));
  const failed = await verifyReviewSession(session, state, async () => { throw Error("unreadable"); });
  expect(failed.verified.size).toBe(0);
  const changed = await verifyReviewSession(session, {...state, revision: "new-status"}, async () => diff);
  expect(changed.verified.size).toBe(0);
  expect(changed.stale.size).toBe(2);
});
it("exports only current verified fingerprints and keeps paths and note Markdown literal", () => {
  const file = {path: "a`file\nnext.ts", index: "M", worktree: "M"};
  const fingerprint = "a".repeat(64);
  const result = reviewReport({state: {root: "C:/project", branch: "feature/review", revision: "r", files: [file]}, capturedAt: "2026-10-29T00:00:00Z", verified: new Set([reviewKey(file.path, true)]), session: {marks: [{key: reviewKey(file.path, true), revision: "r", fingerprint}], notes: {[file.path]: "```\n# Not a heading\n```"}}, labels: {title: "Review", scope: "Capture-time evidence only", project: "Project", branch: "Branch", revision: "Revision", captured: "Captured", summary: "Files", staged: "Staged", working: "Working", reviewed: "Reviewed", pending: "Unverified", notes: "Notes"}});
  expect(result).toContain("- [ ] `` a`file ↵ next.ts ``");
  expect(result).toContain("Working: Unverified");
  expect(result).toContain("Staged: Reviewed · SHA-256");
  expect(result).toContain("````text\n```\n# Not a heading\n```\n````");
  expect(result.match(/a{64}/g)).toHaveLength(1);
});
