// Native media presentation/asset permissions. Optional existing QA profile runs
// one bounded real CLI vision turn; it never imports or copies credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Media test timed out");
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "media-native-")),
    cwd = path.join(fixture, "project");
  const live = process.env.RELAY_MEDIA_LIVE_PROFILE;
  const generation = process.env.RELAY_MEDIA_GENERATION === "1";
  const profile = live || path.join(fixture, "profile");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(profile, "chats"), { recursive: true });
  const id = randomUUID(),
    now = Date.now();
  const job = {
    id,
    title: "图片与来源卡片验收",
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
  if (!live) {
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
        projects: [{ id: randomUUID(), name: "Media QA", cwd }],
        schedules: [],
        preferences: { theme: "dark", language: "zh-CN", notifications: false },
      }),
    );
  }
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, liveJob;
  const errors = [],
    report = {
      fixture,
      profile,
      realModelTurns: 0,
      generation: "protocol fixture only",
    };
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
    page.on("pageerror", (error) => errors.push(error.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    const png = await app.evaluate(({ nativeImage }) => {
      const bitmap = Buffer.alloc(96 * 96 * 4);
      for (let i = 0; i < bitmap.length; i += 4) {
        bitmap[i] = 0;
        bitmap[i + 1] = 0;
        bitmap[i + 2] = 255;
        bitmap[i + 3] = 255;
      }
      return nativeImage
        .createFromBitmap(bitmap, { width: 96, height: 96 })
        .toPNG()
        .toString("base64");
    });
    const source = path.join(cwd, "红色 方块.png"),
      generated = path.join(cwd, "generated-result.png");
    await fs.writeFile(source, Buffer.from(png, "base64"));
    await fs.writeFile(generated, Buffer.from(png, "base64"));
    await page.route("https://relay-media.invalid/result.png", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(png, "base64"),
      }),
    );
    if (live) {
      const snapshot = await call("snapshot");
      assert(
        snapshot.accounts.some(
          (account) => account.enabled && account.status === "ready",
        ),
      );
      assert(
        !snapshot.jobs.some((job) =>
          ["preparing", "running", "rotating", "pausing"].includes(job.state),
        ),
      );
      const reused = process.env.RELAY_MEDIA_REUSE_JOB;
      let token;
      if (reused) {
        const previous = snapshot.jobs.find((job) => job.id === reused);
        assert.equal(previous?.state, "completed");
        token = await fs.readFile(path.join(previous.cwd, "token.txt"), "utf8");
        liveJob = reused;
        report.reusedCompletedModelJob = true;
      } else {
        token = "MEDIA_" + randomUUID().slice(0, 8);
        const tokenFile = path.join(cwd, "token.txt");
        await fs.writeFile(tokenFile, token);
        const added = await call("job.add", {
          title: generation
            ? "真实 CLI 生图结果验收"
            : "真实 CLI 看图与文件附件验收",
          prompt: generation
            ? `Use the native image generation tool exactly once to generate one simple small image of a single red square on a white background, saving the result under ${cwd}. Do not use shell, web, subagents or other tools. Reply only IMAGE_DONE after generating it. If image generation is unavailable, reply IMAGE_UNAVAILABLE and stop. This is one bounded integration test; do not retry or use alternatives.`
            : `This is one bounded integration test. Actually call the view_image tool on ${source} exactly once. Read ${tokenFile} with one shell command. Do not edit files, browse, use other tools or spawn agents. Reply only TOKEN=<the file content> COLOR=<the dominant color in English>.`,
          cwd,
          mode: "cli",
          model: "",
          effort: "low",
          bucket: "codex",
          approvalPolicy: "never",
          sandbox: generation ? "workspaceWrite" : "readOnly",
          interactive: true,
          multiAgent: false,
          attachments: generation
            ? []
            : [
                {
                  type: "localImage",
                  path: source,
                  name: path.basename(source),
                },
                { type: "mention", path: tokenFile, name: "token.txt" },
              ],
        });
        liveJob = added.id;
        report.realModelTurns = 1;
      }
      await until(async () => {
        const state = await call("snapshot"),
          job = state.jobs.find((j) => j.id === liveJob);
        if (["needs_attention", "paused", "cancelled"].includes(job.state))
          throw Error(job.lastError || job.stage || job.state);
        return job.state === "completed";
      }, 180000);
      const chat = await call("chat.read", { id: liveJob });
      const answer = chat.items
        .filter((item) => item.role === "assistant")
        .map((item) => item.text)
        .join("\n");
      if (generation) {
        assert(answer.includes("IMAGE_DONE"), answer);
        assert(
          chat.items.some((item) =>
            item.images?.some((image) => image.origin === "generated"),
          ),
          "Missing actual generation output",
        );
        report.generation = "real CLI generation passed";
      } else {
        assert(answer.includes(token));
        assert(/COLOR=red/i.test(answer));
        assert(
          chat.items.some(
            (item) => item.kind === "imageView" && item.images?.length,
          ),
        );
        report.liveVisionAndFileRead = "passed";
      }
      await page
        .getByRole("button", {
          name: generation
            ? "真实 CLI 生图结果验收"
            : "真实 CLI 看图与文件附件验收",
          exact: true,
        })
        .click();
      await page
        .getByText(generation ? "已生成 1 张图片" : "已查看 1 张图像", {
          exact: true,
        })
        .waitFor();
      report.jobId = liveJob;
    } else {
      const rows = [
        {
          id: "u",
          role: "user",
          kind: "message",
          text: "检查这张图片，并生成一张结果图。",
          detail: source,
          images: [
            {
              id: "input:0",
              origin: "input",
              path: source,
              name: path.basename(source),
            },
          ],
          at: now,
        },
        {
          id: "view",
          role: "tool",
          kind: "imageView",
          text: "imageView",
          status: "completed",
          images: [
            {
              id: "view:0",
              origin: "view",
              path: source,
              name: path.basename(source),
            },
          ],
          at: now,
        },
        {
          id: "gen",
          role: "tool",
          kind: "imageGeneration",
          text: "imageGeneration",
          status: "completed",
          images: [
            {
              id: "gen:0",
              origin: "generated",
              path: generated,
              name: "generated-result.png",
            },
          ],
          at: now,
        },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `change:${i}`,
          role: "tool",
          kind: "fileChange",
          text: "Edit",
          status: "completed",
          data: { changes: [{ path: `src/output-${i}.ts` }] },
          at: now,
        })),
        {
          id: "answer",
          role: "assistant",
          kind: "message",
          text: `图片预览：\n\n![生成结果](${generated.replace(/\\/g, "/")})\n\n![HTTPS 图片](https://relay-media.invalid/result.png)`,
          at: now,
        },
      ];
      for (let i = 0; i < 7; i++) {
        await fs.mkdir(path.join(cwd, "src"), { recursive: true });
        await fs.writeFile(
          path.join(cwd, `src/output-${i}.ts`),
          `export const value = ${i};\n`,
        );
      }
      await fs.writeFile(
        path.join(profile, "chats", `${id}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      await page.getByRole("button", { name: job.title, exact: true }).click();
      await page.getByText("已查看 1 张图像", { exact: true }).waitFor();
      await page.getByText("已生成 1 张图片", { exact: true }).waitFor();
      await page.locator(".summary-assets-more > summary").click();
      await page.getByText("output-6.ts", { exact: true }).waitFor();
      await page.locator(".summary-assets-more > summary").click();
      await assert.rejects(
        () =>
          call("chat.asset.read", {
            id,
            path: path.join(root, "package.json"),
          }),
        /超出/,
      );
      await assert.rejects(
        () => call("chat.asset.read", { id: randomUUID(), path: source }),
        /不存在/,
      );
      report.assetPermissions = "passed";
      report.expandAllAssets = "passed";
    }
    const images = page.locator(".agent-transcript .chat-image-thumbnail img");
    const thumbs = page.locator(".agent-transcript .chat-image-thumbnail");
    for (let index = 0; index < (await thumbs.count()); index++)
      await thumbs.nth(index).scrollIntoViewIfNeeded();
    await until(
      async () =>
        (await images.count()) >= (generation ? 1 : 2) &&
        (await images.evaluateAll((nodes) =>
          nodes.every((node) => node.complete && node.naturalWidth > 0),
        )),
    );
    await page
      .locator(".summary-card .chat-image-thumbnail img")
      .first()
      .waitFor();
    await page.screenshot({
      path: path.join(output, live ? "media-live.png" : "media-native.png"),
    });
    await page
      .locator(".agent-transcript .chat-image-thumbnail")
      .first()
      .click();
    const viewer = page.locator(".modal:has(.image-viewer-canvas)");
    await viewer.waitFor();
    await until(
      async () =>
        await viewer
          .locator("img")
          .evaluate((node) => node.complete && node.naturalWidth > 0),
    );
    await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
    assert.match(await viewer.innerText(), /125%/);
    await viewer.getByRole("button", { name: "重置缩放", exact: true }).click();
    await page.screenshot({ path: path.join(output, "media-viewer.png") });
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    report.rendererErrors = errors;
    report.inlineImagesAndViewer = "passed";
    await fs.writeFile(
      path.join(
        output,
        generation
          ? "media-generation-report.json"
          : live
            ? "media-live-report.json"
            : "media-native-report.json",
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app && liveJob) {
      const page = await app.firstWindow();
      await page
        .evaluate(async (id) => {
          const state = await window.relay.snapshot();
          if (
            state.jobs.some(
              (job) =>
                job.id === id &&
                ["running", "preparing", "rotating"].includes(job.state),
            )
          )
            await window.relay.command("job.control", { id, action: "pause" });
        }, liveJob)
        .catch(() => {});
    }
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
