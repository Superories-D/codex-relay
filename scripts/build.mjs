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
await build({
  entryPoints: ["src/renderer/App.tsx"],
  outfile: "dist/renderer/app.js",
  bundle: true,
  platform: "browser",
  target: "chrome130",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("src/renderer/index.html", "dist/renderer/index.html");
console.log("Built main, isolated preload, and renderer.");
