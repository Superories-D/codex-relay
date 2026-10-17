import { normalizeLocalPath } from "../shared/file-reference";

/** Presentation only: the persisted answer and whole-answer copy stay original. */
export function normalizeMessage(text: string, streaming = false): string {
  text = displayTerminalText(text);
  if (!streaming && text.length <= 262144 && /^\s*[\[{]/.test(text)) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object")
        return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
    } catch {
      /* Prose and incomplete JSON keep their original presentation. */
    }
  }
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let plain: string[] = [];
  let displayMath = false;
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (plain.length) output.push(normalizeMathDelimiters(plain.join("\n")));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence && (displayMath || /^ {0,3}\\\[\s*$/.test(line))) {
      plain.push(line);
      displayMath = !/^\s*\\\]\s*$/.test(line);
      continue;
    }
    const standard = line.match(/^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (
        standard &&
        standard[1][0] === fence.marker &&
        standard[1].length >= fence.length &&
        !standard[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (standard && !(standard[1][0] === "`" && standard[2].includes("`"))) {
      flush();
      fence = { marker: standard[1][0], length: standard[1].length };
      output.push(line);
      continue;
    }
    // Indented code and Python docstrings inside real fences are never changed.
    if (/^( {4}|\t)/.test(line)) {
      flush();
      output.push(line);
      continue;
    }
    const quoted = line.match(/^ {0,3}"""([a-zA-Z][\w+.#/-]*)?[ \t]*$/);
    if (quoted) {
      let end = i + 1;
      while (end < lines.length && !/^ {0,3}"""[ \t]*$/.test(lines[end])) end++;
      if (end < lines.length || streaming) {
        flush();
        const body = lines.slice(i + 1, end);
        // An alias block may contain Markdown fences as literal code.
        let longest = 2;
        for (const line of body)
          for (const match of line.matchAll(/`+/g))
            longest = Math.max(longest, match[0].length);
        const marker = "`".repeat(longest + 1);
        output.push(marker + (quoted[1] || ""));
        for (const line of body) output.push(line);
        if (end < lines.length) output.push(marker);
        i = end;
        continue;
      }
    }
    plain.push(line);
  }
  flush();
  return output.join("\n");
}

export function displayTerminalText(text: string) {
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function normalizeMathDelimiters(text: string): string {
  let result = "",
    i = 0;
  while (i < text.length) {
    if (
      text[i] === "$" &&
      text[i - 1] !== "$" &&
      /\d/.test(text[i + 1] || "")
    ) {
      const end = text.indexOf("$", i + 1);
      // Prices and ranges such as "$5 and $20" are prose, not equations.
      if (
        end < 0 ||
        /\d/.test(text[end + 1] || "") ||
        /^\d+(?:[.,]\d+)?\s+(?:and|or|to|per|each|for)\b/i.test(
          text.slice(i + 1, end),
        )
      ) {
        result += "\\$";
        i++;
        continue;
      }
    }
    if (text[i] === "`") {
      const marker = text.slice(i).match(/^`+/)![0];
      let close = text.indexOf(marker, i + marker.length);
      while (
        close >= 0 &&
        (text[close - 1] === "`" || text[close + marker.length] === "`")
      )
        close = text.indexOf(marker, close + marker.length);
      if (close >= 0) {
        result += text.slice(i, close + marker.length);
        i = close + marker.length;
        continue;
      }
    }
    if (text[i] === "\\") {
      // Preserve literal escaped backslashes, including \\(x\\).
      if (text[i + 1] === "\\") {
        result += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      const display = text[i + 1] === "[",
        inline = text[i + 1] === "(";
      if ((display || inline) && (i === 0 || !/[\w:]/.test(text[i - 1]))) {
        const closing = display ? "\\]" : "\\)";
        let end = text.indexOf(closing, i + 2);
        while (end >= 0 && text[end - 1] === "\\")
          end = text.indexOf(closing, end + 2);
        if (end >= 0) {
          const body = text.slice(i + 2, end).trim();
          if (body && (display || !body.includes("\n"))) {
            result += display ? `\n$$\n${body}\n$$\n` : `$${body}$`;
            i = end + 2;
            continue;
          }
        }
      }
    }
    result += text[i++];
  }
  return result;
}

export interface TextNode {
  type: string;
  value?: string;
  tagName?: string;
  children?: TextNode[];
}
export function decodeFileLink(value: string): string {
  let target = value;
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      target =
        (url.hostname && url.hostname !== "localhost"
          ? `//${url.hostname}`
          : "") + url.pathname;
    } catch {
      // Preserve malformed links for a readable file error, never execute them.
    }
  }
  // Strip location syntax before decoding, so %23L2 remains a literal filename.
  target = target
    .replace(/#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/i, "")
    .replace(/:\d+(?::\d+)?$/, "");
  const decoded = target.replace(/(?:%[a-f\d]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
  return normalizeLocalPath(decoded);
}
export function nodeText(node?: TextNode): string {
  if (!node) return "";
  return node.type === "text"
    ? node.value || ""
    : (node.children || []).map(nodeText).join("");
}
export function mathSource(node?: TextNode): string {
  if (node?.tagName === "annotation") return nodeText(node);
  for (const child of node?.children || []) {
    const value = mathSource(child);
    if (value) return value;
  }
  return "";
}
