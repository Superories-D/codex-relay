import { spawn } from "node:child_process";
import { createRequire } from "node:module";
await import("./build.mjs");
const require = createRequire(import.meta.url);
const electron = require("electron");
const child = spawn(electron, ["."], { stdio: "inherit", env: process.env });
child.on("close", (code) => process.exit(code ?? 1));
