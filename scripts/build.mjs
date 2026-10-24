import { build } from "esbuild";
import { mkdir, copyFile, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/renderer", { recursive: true });
await mkdir("dist/main", { recursive: true });
await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/main/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
});
await build({
  entryPoints: ["src/core/history-import-worker.ts"],
  outfile: "dist/main/history-import-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
await build({entryPoints:["src/core/operations-worker.ts"],outfile:"dist/main/operations-worker.cjs",bundle:true,platform:"node",target:"node22",format:"cjs"});
await build({
  entryPoints: ["src/renderer/App.tsx"],
  outfile: "dist/renderer/app.js",
  bundle: true,
  platform: "browser",
  target: "chrome130",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
});
await copyFile("src/renderer/index.html", "dist/renderer/index.html");
await mkdir("dist/renderer/assets", { recursive: true });
await copyFile("node_modules/katex/LICENSE", "dist/renderer/assets/KaTeX-LICENSE.txt");
console.log("Built main, isolated preload, and renderer.");

await build({entryPoints:["src/server/main.ts"],outfile:"dist/server/main.cjs",bundle:true,platform:"node",target:"node22",format:"cjs",sourcemap:true});

await build({entryPoints:["src/server/ui/App.tsx"],outfile:"dist/server/ui/app.js",bundle:true,platform:"browser",target:"chrome130",format:"iife",minify:true,define:{"process.env.NODE_ENV":'"production"'}});
await copyFile("src/server/ui/index.html","dist/server/ui/index.html");
await build({entryPoints:["src/server/backup-main.ts"],outfile:"dist/server/backup.cjs",bundle:true,platform:"node",target:"node22",format:"cjs"});
