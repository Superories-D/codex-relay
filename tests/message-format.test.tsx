import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MarkdownText } from "../src/renderer/RichMessage";
import {
  normalizeMessage,
  decodeFileLink,
} from "../src/renderer/message-format";
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
