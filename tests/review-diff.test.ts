import { describe, expect, it } from "vitest";
import {
  reviewCodeBlock,
  reviewDiff,
  reviewExcerpt,
  reviewLocation,
} from "../src/shared/review-diff";

const header =
  "diff --git a/note.txt b/note.txt\nindex 1234567..abcdef0 100644\n--- a/note.txt\n+++ b/note.txt\n";
describe("review diff coordinates", () => {
  it("quotes embedded Markdown fences and many backtick runs without changing source", () => {
    expect(reviewCodeBlock("+```js\n+example\n+```")).toBe(
      "````diff\n+```js\n+example\n+```\n````",
    );
    const manyRuns = "+" + "`a".repeat(150000);
    expect(reviewCodeBlock(manyRuns)).toBe("```diff\n" + manyRuns + "\n```");
  });
  it("tracks independent old/new coordinates across multiple hunks and metadata", () => {
    const parsed = reviewDiff(
      header +
        "@@ -2,3 +2,4 @@ title\n before\n-old\n+new\n+extra\n after\n@@ -20 +21 @@\n-last\n+final\n\\ No newline at end of file\n",
    );
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(2);
    expect(parsed.metadata).toHaveLength(4);
    expect(parsed.hunks[0].lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [2, 2],
      [3, undefined],
      [undefined, 3],
      [undefined, 4],
      [4, 5],
    ]);
    expect(parsed.hunks[1].lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [20, undefined],
      [undefined, 21],
      [undefined, undefined],
    ]);
    expect(reviewLocation("日本語 note.txt", parsed.hunks[1].lines[0])).toBe(
      "日本語 note.txt:20",
    );
    expect(reviewLocation("日本語 note.txt", parsed.hunks[1].lines[1])).toBe(
      "日本語 note.txt:21",
    );
    expect(reviewExcerpt(parsed.hunks[0].lines[2], parsed.hunks[0])).toBe(
      "@@ -2,3 +2,4 @@ title\n before\n-old\n+new\n+extra\n after",
    );
  });

  it("does not count file headers as additions or mistake source prefixes for metadata", () => {
    const parsed = reviewDiff(
      header + "@@ -0,0 +1,2 @@\n+++source\n+---source\n",
    );
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(0);
    expect(parsed.hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2]);
    const deleted = reviewDiff(header + "@@ -1,2 +0,0 @@\n-one\n-two\n");
    expect(deleted.hunks[0].lines.map((l) => l.oldLine)).toEqual([1, 2]);
    expect(deleted.removed).toBe(2);
  });

  it("preserves malformed, truncated, combined, binary and multiple-file output verbatim", () => {
    for (const diff of [
      header + "@@ -1,2 +1,2 @@\n-old\n+new\n",
      header + "@@ -1 +1 @@\n-old\n+new\ninvalid\n",
      header + "@@@ -1,1 -1,1 +1,1 @@@\n--old\n++new\n",
      "diff --git a/a b/a\nBinary files a/a and b/a differ\n",
      header + "@@ -1 +1 @@\n-a\n+b\n" + header + "@@ -1 +1 @@\n-c\n+d\n",
    ]) {
      const parsed = reviewDiff(diff);
      expect(parsed.hunks).toEqual([]);
      expect(parsed.metadata.join("\n") + "\n").toBe(diff);
    }
  });

  it("keeps CRLF source content and blank lines without offsetting coordinates", () => {
    const parsed = reviewDiff(
      header + "@@ -1,2 +1,2 @@\n \r\n-old\r\n+new\r\n",
    );
    expect(parsed.hunks[0].lines[0].text).toBe(" \r");
    expect(parsed.hunks[0].lines[2]).toMatchObject({
      text: "+new\r",
      newLine: 2,
    });
  });
});
