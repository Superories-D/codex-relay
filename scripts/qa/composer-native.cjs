// Real OS clipboard, sandboxed preload and Electron rendering. No sign-in/inference.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(75);
  }
  throw Error("Timed out waiting for composer state");
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "composer-native-"));
  const profile = path.join(fixture, "profile"),
    cwd = path.join(fixture, "project");
  await fs.mkdir(path.join(profile, "chats"), { recursive: true });
  await fs.mkdir(cwd);
  const files = [path.join(cwd, "中文 文件.txt"), path.join(cwd, "second.js")];
  await fs.writeFile(files[0], "Copied from Explorer 世界\n");
  await fs.writeFile(files[1], "console.log(42);\n");
  const id = randomUUID(),
    now = Date.now();
  const job = {
    id,
    title: "附件与活动动效验收",
    prompt: "No inference",
    cwd,
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "completed",
    rotations: 0,
    createdAt: now,
    updatedAt: now,
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
    interactive: true,
  };
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      jobs: [job],
      accounts: [],
      logs: [],
      cursor: 0,
      settings: {},
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [{ id: randomUUID(), name: "Clipboard QA", cwd }],
      schedules: [],
      preferences: { theme: "dark", language: "zh-CN", notifications: false },
    }),
  );
  const rows = [
    {
      id: "intro",
      role: "assistant",
      kind: "message",
      text: "已完成检查，以下为工具操作。",
      at: now,
    },
    ...Array.from({ length: 90 }, (_, i) => ({
      id: `tool-${i}`,
      role: "tool",
      kind: i % 3 ? "commandExecution" : "fileChange",
      text: i % 3 ? `node check-${i}.js` : `Edit source-${i}.ts`,
      detail: `Output ${i}\n` + "result line\n".repeat(10),
      data: i % 3 ? undefined : { changes: [{ path: `source-${i}.ts` }] },
      status: i === 89 ? "failed" : i === 88 ? "running" : "completed",
      at: now,
    })),
    {
      id: "answer",
      role: "assistant",
      kind: "message",
      text: "正文保持可见。",
      at: now,
    },
  ];
  await fs.writeFile(
    path.join(profile, "chats", `${id}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app,
    saved = false;
  const errors = [],
    report = { inferenceRequests: 0, fixture };
  try {
    app = await _electron.launch({
      executablePath:
        process.env.RELAY_EXECUTABLE ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: job.title, exact: true }).click();
    const input = page.getByLabel("消息", { exact: true });
    await input.waitFor();
    await page
      .getByRole("button", { name: "加载更早的消息", exact: true })
      .click();
    await until(
      async () =>
        (await page
          .getByRole("button", { name: "加载更早的消息", exact: true })
          .count()) === 0,
    );
    const group = page.locator(".agent-transcript .activity-group");
    await until(async () => (await group.count()) === 1);
    assert.equal(await group.getAttribute("open"), null);
    assert.equal(
      await group.locator(".activity-item").count(),
      0,
      "collapsed groups render no heavy output",
    );
    assert.match(
      await group.locator(":scope > summary").innerText(),
      /90 项操作/,
    );
    assert.match(await group.locator(":scope > summary").innerText(), /进行中/);
    assert.match(
      await group.locator(":scope > summary").innerText(),
      /1 项失败/,
    );
    await group.locator(":scope > summary").click();
    await until(
      async () => (await group.locator(".activity-item").count()) === 90,
    );
    await pause(260);
    const height = (await group.boundingBox()).height;
    assert(height > 100 && height < 410);
    await page.screenshot({
      path: path.join(output, "composer-activity-expanded.png"),
    });
    const collapseFrames = await group.evaluate(async (node) => {
      const frames = [];
      node.querySelector("summary").click();
      const start = performance.now();
      while (performance.now() - start < 300) {
        await new Promise(requestAnimationFrame);
        frames.push(node.getBoundingClientRect().height);
      }
      return frames;
    });
    assert(
      collapseFrames.some((h) => h > 45 && h < height - 5),
      "collapse has intermediate animation frames",
    );
    assert(collapseFrames.at(-1) < 45);
    report.collapseFrames = collapseFrames.length;
    report.collapseIntermediateFrames = collapseFrames.filter(
      (h) => h > 45 && h < height - 5,
    ).length;
    await group.locator(":scope > summary").click();
    await pause(250);
    assert.equal(await group.getAttribute("open"), "");
    await group.locator(":scope > summary").click();
    await pause(250);
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      // Materialize before replacing the clipboard; retain privately in the main process.
      globalThis.__relayQAClipboard = await Promise.all(
        (await clipboard.read()).map(async (item) => {
          const data = {};
          for (const type of item.types) data[type] = await item.getType(type);
          return new ClipboardItem(data);
        }),
      );
    });
    saved = true;
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText("普通文本\n第二行");
    });
    await input.fill("draft:");
    await input.press("End");
    await input.press("Control+V");
    await until(async () =>
      (await input.inputValue()).includes("普通文本\n第二行"),
    );
    assert.equal(await page.locator(".agent-attachments .draft-attachment").count(), 0);
    report.plainText = "passed";
    await app.evaluate(
      async ({ clipboard, ClipboardItem }, uris) => {
        await clipboard.write([new ClipboardItem({ "text/uri-list": uris })]);
      },
      files.map((f) => pathToFileURL(f).href).join("\r\n"),
    );
    await input.press("Control+V");
    await until(
      async () =>
        (await page.locator(".agent-attachments .draft-attachment").count()) === 2,
    );
    const copiedPaths = await page
      .locator(".agent-attachments .draft-attachment")
      .evaluateAll((nodes) => nodes.map((node) => node.title));
    assert(
      copiedPaths.every((file) =>
        file.startsWith(path.join(profile, "attachments")),
      ),
    );
    assert.equal(
      await fs.readFile(copiedPaths[0], "utf8"),
      "Copied from Explorer 世界\n",
    );
    assert.equal(
      await fs.readFile(copiedPaths[1], "utf8"),
      "console.log(42);\n",
    );
    await fs.unlink(files[0]);
    assert.equal(
      await fs.readFile(copiedPaths[0], "utf8"),
      "Copied from Explorer 世界\n",
    );
    report.nativeFilePaste = "passed";
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
      const bytes = nativeImage
        .createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), {
          width: 16,
          height: 16,
        })
        .toPNG();
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([bytes], { type: "image/png" }),
        }),
      ]);
      if (!(await clipboard.has("image/png")))
        throw Error("Native clipboard did not accept the fixture image");
    });
    await input.press("Control+V");
    try {
      await until(
        async () =>
          (await page.locator(".agent-attachments .draft-attachment").count()) === 3,
      );
    } catch (e) {
      console.log(await page.locator(".agent-error").allTextContents());
      console.log(
        await app.evaluate(async ({ clipboard }) =>
          (await clipboard.read()).map((i) => i.types),
        ),
      );
      throw e;
    }
    const imagePath = await page
      .locator(".agent-attachments .draft-attachment")
      .last()
      .getAttribute("title");
    assert.equal(
      (await fs.readFile(imagePath)).subarray(1, 4).toString(),
      "PNG",
    );
    report.imagePaste = "passed";
    await page.waitForFunction(() => {
      const img = document.querySelector('.draft-attachment img');
      return img?.complete && img.naturalWidth > 0;
    });
    await page.locator('.draft-attachment .chat-image-thumbnail').click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { includeHidden: true }).waitFor({ state: 'detached' });
    report.draftImagePreview = "passed";
    // Exercise disk-backed File -> webUtils bridge as well as the clipboard fallback.
    await page.evaluate(() => {
      const element = document.createElement("input");
      element.type = "file";
      element.id = "qa-native-file";
      element.hidden = true;
      document.body.append(element);
    });
    await page.locator("#qa-native-file").setInputFiles(files[1]);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(document.querySelector("#qa-native-file").files[0]);
      document
        .querySelector(".agent-composer")
        .dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
    });
    await until(
      async () =>
        (await page.locator(".agent-attachments .draft-attachment").count()) === 4,
    );
    report.nativeFileDrop = "passed";
    assert.equal(
      await input.evaluate((node) => node === document.activeElement),
      true,
    );
    await page.screenshot({ path: path.join(output, "composer-native.png") });
    // Reduced motion must remove both timeline and panel transition animations.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pause(50);
    const reduced = await group.evaluate((node) => ({
      transition: getComputedStyle(node, "::details-content")
        .transitionDuration,
      animations: node
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running").length,
    }));
    if (reduced.animations)
      console.log(
        await group.evaluate((node) =>
          node
            .getAnimations({ subtree: true })
            .map((a) => ({
              type: a.constructor.name,
              state: a.playState,
              target: a.effect.target?.className,
              name: a.animationName,
              transition: a.transitionProperty,
              style: a.effect.target
                ? getComputedStyle(a.effect.target).animation
                : "",
            })),
        ),
      );
    assert.equal(reduced.transition, "0s");
    assert.equal(reduced.animations, 0);
    report.reducedMotion = "passed";
    assert.deepEqual(errors, []);
    report.rendererErrors = errors;
    await fs.writeFile(
      path.join(output, "composer-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app && saved)
      await app
        .evaluate(async ({ clipboard }) => {
          if (globalThis.__relayQAClipboard) {
            await clipboard.write(globalThis.__relayQAClipboard);
            delete globalThis.__relayQAClipboard;
          }
        })
        .catch(() => {});
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
