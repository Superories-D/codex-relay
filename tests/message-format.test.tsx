import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MarkdownText, RichMessage } from "../src/renderer/RichMessage";
import {
  normalizeMessage,
  decodeFileLink,
} from "../src/renderer/message-format";
import { normalizeLocalPath } from "../src/shared/file-reference";
it("keeps user shell variables, Windows paths and Markdown punctuation literal without changing assistant math", () => {
  const text =
    '$agentDeadline=(Get-Date); while ($agentDeadline) { Test-Path "D:\\_work\\a_b.md" }\n<script>literal</script> **literal**';
  const callbacks = {
    onOpen: () => {},
    onAgents: () => {},
    onChanges: () => {},
  };
  const html = renderToStaticMarkup(
    <RichMessage
      {...callbacks}
      item={{ id: "user-literal", role: "user", kind: "message", text, at: 1 }}
    />,
  );
  expect(html).toContain('class="user-message-text"');
  expect(html).toContain("$agentDeadline=(Get-Date)");
  expect(html).toContain("D:\\_work\\a_b.md");
  expect(html).toContain("&lt;script&gt;literal&lt;/script&gt; **literal**");
  expect(html).not.toContain("katex");
  const assistant = renderToStaticMarkup(
    <RichMessage
      {...callbacks}
      item={{
        id: "assistant-math",
        role: "assistant",
        kind: "message",
        text: "$E=mc^2$",
        at: 1,
      }}
    />,
  );
  expect(assistant).toContain("katex");
});
it("formats standalone paired triple quotes while preserving embedded fences and exact code whitespace", () => {
  const text =
    'Before\n\n"""python\n  x = "你好 → ≥"\n```literal```\n\n"""\n\nAfter';
  const normalized = normalizeMessage(text);
  expect(normalized).toBe(
    'Before\n\n````python\n  x = "你好 → ≥"\n```literal```\n\n````\n\nAfter',
  );
  const html = renderToStaticMarkup(<MarkdownText text={text} />);
  expect(html).toContain('class="code-block"');
  expect(html).toContain("复制代码");
  expect(html).toContain("你好 → ≥");
});
it("does not change Python docstrings, nested quote fences, indented code, inline code, or ordinary prose", () => {
  for (const text of [
    '```python\ndef x():\n    """\n    \\(not math\\)\n    """\n```',
    "> ~~~python\n> \\(not math\\)\n> ~~~",
    '    """\n    \\(not math\\)\n    """',
    "Use `\\(x\\)` and `` `\\[x\\]` ``.",
    'The string """ is part of Python.',
    '"""\nAn unfinished quotation',
    "C:\\(draft\\) and \\\\(literal\\\\)",
  ])
    expect(normalizeMessage(text)).toBe(text);
});
it("presents unfinished streaming alias code without writing synthetic delimiters to the source", () => {
  const text = '"""json\n{"hello": "世界"';
  expect(normalizeMessage(text, true)).toBe('```json\n{"hello": "世界"');
  expect(normalizeMessage(text)).toBe(text);
});
it("renders both native LaTeX delimiter forms and preserves Unicode symbols", () => {
  const text = String.raw`Inline \(\alpha + \beta \ge 1\).

\[
\int_0^1 x^2\,dx = \frac{1}{3}
\]

→ ← × ÷ ≤ ≥ ≠ ∞ ± ✓ &amp; &lt;`;
  const html = renderToStaticMarkup(<MarkdownText text={text} />);
  expect(html).toContain('class="katex"');
  expect(html).toContain('class="math-block"');
  expect(html).toContain("复制公式");
  expect(html).toContain("application/x-tex");
  expect(html).toContain("→ ← × ÷ ≤ ≥ ≠ ∞ ± ✓ &amp; &lt;");
});
it("preserves indented multi-line formulas and leaves currency as plain text", () => {
  const text = String.raw`\[
    \frac{a}{b} \ge 1
\]

Price: $5 and $20. Also USD 30.`;
  const html = renderToStaticMarkup(<MarkdownText text={text} />);
  expect(html.match(/class="katex"/g)).toHaveLength(1);
  expect(html).toContain("Price: $5 and $20.");
});
it("keeps tables, tasks, block quotes, nested lists, rules and standard code fences working", () => {
  const text =
    '# Heading\n\n> Quote\n\n- [x] Done\n- [ ] Next\n\n1. First\n   - Nested\n\n| Name | Value |\n|---|---:|\n| Result | **42** |\n\n---\n\n```json\n{"value": 42}\n```';
  const html = renderToStaticMarkup(<MarkdownText text={text} />);
  for (const tag of [
    "<h1>",
    "<blockquote>",
    "<table>",
    "<ol>",
    "<ul>",
    '<input type="checkbox"',
    "<hr/>",
    'class="code-block"',
  ])
    expect(html).toContain(tag);
});
it("renders math safely without enabling embedded HTML, scripts, trusted commands or remote assets", () => {
  const html = renderToStaticMarkup(
    <MarkdownText
      text={String.raw`<script>alert(1)</script>

$\href{javascript:alert(1)}{bad}$ $\includegraphics{https://example.invalid/secret}$

[bad](javascript:alert(1))`}
    />,
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="https://example.invalid');
});
it("handles literal percent signs in file references without throwing", () => {
  expect(decodeFileLink("C:/项目/100%完成.ts")).toBe("C:/项目/100%完成.ts");
  expect(decodeFileLink("C:/My%20Project/main.ts")).toBe(
    "C:/My Project/main.ts",
  );
  expect(() =>
    renderToStaticMarkup(
      <MarkdownText text="![preview](</project/100%ready.png>)" />,
    ),
  ).not.toThrow();
});
it("normalizes URL-style Windows drives without duplicating the drive or corrupting filenames", () => {
  for (const link of [
    "/D:/My%20Project/docs/story-editor.md",
    "D:/My%20Project/docs/story-editor.md:12:3",
    "/D:/My%20Project/docs/story-editor.md#L12C3-L14",
    "file:///D:/My%20Project/docs/story-editor.md#L12",
    "file://localhost/D:/My%20Project/docs/story-editor.md",
  ])
    expect(decodeFileLink(link)).toBe("D:/My Project/docs/story-editor.md");
  expect(decodeFileLink("/D:/My%20Project/100%完成%20%231.md")).toBe(
    "D:/My Project/100%完成 #1.md",
  );
  expect(decodeFileLink("D:/project/literal%2520%23L12")).toBe(
    "D:/project/literal%20#L12",
  );
  expect(normalizeLocalPath("D:/project/100%20.md")).toBe(
    "D:/project/100%20.md",
  );
  expect(normalizeLocalPath("/usr/local/file.md")).toBe("/usr/local/file.md");
  expect(decodeFileLink("docs/story-editor.md")).toBe("docs/story-editor.md");
  expect(decodeFileLink("file:///tmp/My%20Project/file.md")).toBe(
    "/tmp/My Project/file.md",
  );
  expect(decodeFileLink("file://server/share/file.md")).toBe(
    "//server/share/file.md",
  );
  const html = renderToStaticMarkup(
    <MarkdownText text="[file](file:///D:/project/story-editor.md) [bad](javascript:alert(1))" />,
  );
  expect(html).not.toContain("javascript:");
});
