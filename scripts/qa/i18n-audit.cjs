const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "../..");

function audit(language = "en") {
  if (!["en", "ja"].includes(language))
    throw Error("Unsupported audit language");
  const built = esbuild.buildSync({
    entryPoints: [path.join(root, `src/renderer/locales/${language}.ts`)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const dictionary = { exports: {} };
  new Function("module", "exports", built.outputFiles[0].text)(
    dictionary,
    dictionary.exports,
  );
  const keys = new Map(),
    unlocalized = [];
  const files = fs
    .readdirSync(path.join(root, "src/renderer"))
    .map((name) => path.join("src/renderer", name));
  files.push("src/main/main.ts");
  for (const file of files) {
    const name = path.basename(file);
    if (!/\.tsx?$/.test(name) || name === "i18n.ts") continue;
    const source = ts.createSourceFile(
      name,
      fs.readFileSync(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["t", "nativeText"].includes(node.expression.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        keys.set(node.arguments[0].text, name);
      if (ts.isJsxText(node) && /[\u3400-\u9fff]/.test(node.text))
        unlocalized.push(
          `${name}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}: ${node.text.trim()}`,
        );
      if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        /[\u3400-\u9fff]/.test(node.initializer.text)
      )
        unlocalized.push(`${name}: ${node.name.text}=${node.initializer.text}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return {
    keys: keys.size,
    missing: [...keys]
      .filter(
        ([key]) =>
          !(
            key in
            dictionary.exports[language === "ja" ? "japanese" : "english"]
          ),
      )
      .map(([key, file]) => ({ key, file })),
    unlocalized,
  };
}
module.exports = { audit };
if (require.main === module) {
  const result = audit(process.argv[2] || "en");
  console.log(JSON.stringify(result, null, 2));
  if (result.missing.length || result.unlocalized.length) process.exitCode = 1;
}
