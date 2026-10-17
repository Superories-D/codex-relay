// Real Electron with an account-free, synthetic history. Checks actual layout,
// input gestures and journal refresh; never starts a CLI/model turn.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "scroll-native-")),
    cwd = path.join(profile, "project"),
    id = randomUUID(),
    second = randomUUID(),
    now = Date.now();
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(profile, "chats"));
  const job = (id, title) => ({
    id,
    title,
    cwd,
    prompt: "",
    mode: "cli",
    state: "completed",
    interactive: true,
    model: "",
    effort: "",
    bucket: "codex",
    sandbox: "readOnly",
    approvalPolicy: "never",
    rotations: 0,
    createdAt: now,
    updatedAt: now,
  });
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [
        job(id, "Scroll verification"),
        job(second, "Second conversation"),
      ],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [{ id: randomUUID(), name: "Scroll QA", cwd }],
      schedules: [],
      preferences: { language: "zh-CN", theme: "dark", notifications: false },
    }),
  );
  const journal = path.join(profile, "chats", id + ".jsonl"),
    rows = Array.from({ length: 36 }, (_, n) => ({
      id: randomUUID(),
      role: "assistant",
      kind: "message",
      at: now,
      text:
        `### Section ${n}\n\n` +
        "Preserve the reader's position while the assistant works. ".repeat(12),
    }));
  rows.push(
    ...[1, 2].map((n) => ({
      id: randomUUID(),
      role: "tool",
      kind: "commandExecution",
      at: now,
      text: `verification-command-${n}`,
      status: "completed",
      detail: "Output line\n".repeat(20),
    })),
    {
      id: randomUUID(),
      role: "assistant",
      kind: "message",
      at: now,
      text: "SCROLL_END_MARKER",
    },
  );
  await fs.writeFile(
    journal,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(profile, "chats", second + ".jsonl"),
    JSON.stringify({
      id: randomUUID(),
      role: "assistant",
      kind: "message",
      text: "SECOND_CHAT",
      at: now,
    }) + "\n",
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.RELAY_EXECUTABLE;
  const report = {
    syntheticHistory: true,
    inferenceRequests: 0,
    accountCount: 0,
    languages: [],
    checks: [],
    rendererErrors: [],
  };
  let app, page;
  try {
    app = await _electron.launch({
      executablePath:
        executable ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: executable ? [] : [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    const frames = () =>
      page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
    const bottom = () =>
      page.waitForFunction(
        () => {
          const el = document.querySelector(".agent-scroll");
          return el && el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        },
        undefined,
        { timeout: 5000 },
      );
    const home = async () => {
      await page.locator(".agent-scroll").focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(
        () => document.querySelector(".agent-scroll").scrollTop < 4,
      );
    };
    const top = () =>
      page.locator(".agent-scroll").evaluate((el) => el.scrollTop);
    for (const [
      language,
      latest,
      details,
      closePanel,
      settings,
      back,
      reduced,
    ] of [
      [
        "zh-CN",
        "回到最新消息",
        "会话信息",
        "关闭工作面板",
        "设置",
        "返回聊天",
        "减少动态效果",
      ],
      [
        "en",
        "Back to latest message",
        "Chat details",
        "Close work panel",
        "Settings",
        "Back to chat",
        "Reduce motion",
      ],
      [
        "zh-TW",
        "回到最新訊息",
        "會話資訊",
        "關閉工作面板",
        "設定",
        "返回聊天",
        "減少動態效果",
      ],
    ]) {
      await call("desktop.preferences", {
        language,
        theme: language === "en" ? "light" : "dark",
        reduceMotion: false,
      });
      await page.reload();
      await page
        .getByRole("button", { name: "Scroll verification", exact: true })
        .click();
      await page.getByText("SCROLL_END_MARKER", { exact: true }).waitFor();
      // Explicitly return to end in case a previous language saved a reading position.
      await page.locator(".agent-scroll").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await bottom();
      for (const [width, height] of [
        [1440, 1000],
        [900, 650],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width, height });
        await bottom();
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.2),
      );
      await bottom();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
      );
      await bottom();
      const input = page.locator(".agent-composer textarea");
      await input.fill("A growing draft\n".repeat(12));
      await frames();
      await bottom();
      await input.fill("");
      await bottom();
      if (
        await page
          .getByRole("button", { name: closePanel, exact: true })
          .count()
      ) {
        await page
          .getByRole("button", { name: closePanel, exact: true })
          .click();
        await page.locator(".workbench").waitFor({ state: "hidden" });
      }
      await page.getByRole("button", { name: details, exact: true }).click();
      await page.locator(".workbench-tabs").waitFor();
      await bottom();
      await page.getByRole("button", { name: closePanel, exact: true }).click();
      await page.locator(".workbench").waitFor({ state: "hidden" });
      await bottom();
      const summary = page.locator(".activity-group > summary").last();
      await summary.evaluate((el) =>
        el.addEventListener(
          "pointerdown",
          () => {
            window.qaSummaryTop = el.getBoundingClientRect().top;
          },
          { once: true },
        ),
      );
      await summary.click();
      await page
        .locator(".activity-group[open] .activity-item")
        .first()
        .waitFor();
      await page.waitForTimeout(300);
      const summaryPosition = await summary.evaluate((el) => ({
        before: window.qaSummaryTop,
        after: el.getBoundingClientRect().top,
      }));
      assert(
        Math.abs(summaryPosition.after - summaryPosition.before) < 4,
        "Opening command history must not jump past its header: " +
          JSON.stringify(summaryPosition),
      );
      await summary.click();
      await page.waitForTimeout(300);
      await home();
      await page.locator(".agent-scroll").evaluate((el) => {
        el.scrollTop = 370;
        el.dispatchEvent(new Event("scroll"));
      });
      await page.getByRole("button", { name: latest, exact: true }).waitFor();
      await page.setViewportSize({ width: 1440, height: 700 });
      await frames();
      assert(
        Math.abs((await top()) - 370) < 4,
        "Height resize preserves upward reading",
      );
      // Leaving the chat and returning preserves reading position, without selecting another chat.
      await page.getByRole("button", { name: settings, exact: true }).click();
      await page.getByRole("button", { name: back, exact: true }).click();
      await frames();
      assert(
        Math.abs((await top()) - 370) < 4,
        "Settings return preserves a nonzero reading position",
      );
      await page
        .getByRole("button", { name: "Second conversation", exact: true })
        .click();
      await page.getByText("SECOND_CHAT", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Scroll verification", exact: true })
        .click();
      await frames();
      assert(
        Math.abs((await top()) - 370) < 4,
        "Switching chats preserves reading position",
      );
      const samples = await page.evaluate(async () => {
        const el = document.querySelector(".agent-scroll"),
          values = [];
        document.querySelector(".chat-follow-latest").click();
        for (let n = 0; n < 8; n++) {
          await new Promise(requestAnimationFrame);
          values.push(el.scrollTop);
        }
        return {
          values,
          max: el.scrollHeight - el.clientHeight,
          root: document.scrollingElement.scrollTop,
        };
      });
      assert(
        samples.values.some((y) => y > 0 && y < samples.max - 4),
        "Return to latest animates instead of snapping",
      );
      assert.equal(samples.root, 0, "Only the conversation scrolls");
      await bottom();
      await home();
      // Interrupt an in-flight return using a real wheel gesture.
      await page.getByRole("button", { name: latest, exact: true }).click();
      await frames();
      const bounds = await page.locator(".agent-scroll").boundingBox();
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(400);
      const interrupted = await top();
      await page.waitForTimeout(300);
      assert(
        Math.abs((await top()) - interrupted) < 4,
        "Wheel interrupts animated following",
      );
      await page.getByRole("button", { name: latest, exact: true }).waitFor();
      await page.getByRole("button", { name: settings, exact: true }).click();
      await page.getByRole("switch", { name: reduced, exact: true }).click();
      await page.getByRole("button", { name: back, exact: true }).click();
      await page.locator(".desktop-shell.reduce-motion").waitFor();
      await page.getByRole("button", { name: latest, exact: true }).click();
      await frames();
      assert(
        await page
          .locator(".agent-scroll")
          .evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
          ),
        "Reduced motion returns within two frames",
      );
      await page.getByRole("button", { name: settings, exact: true }).click();
      await page.getByRole("switch", { name: reduced, exact: true }).click();
      await page.getByRole("button", { name: back, exact: true }).click();
      await page.locator(".desktop-shell:not(.reduce-motion)").waitFor();
      await home();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: latest, exact: true }).click();
      await frames();
      assert(
        await page
          .locator(".agent-scroll")
          .evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
          ),
        "System reduced motion returns within two frames",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.setViewportSize({ width: 900, height: 900 });
      await bottom();
      await home();
      await page.screenshot({
        path: path.join(output, `desktop-scroll-${language}.png`),
      });
      assert.equal((await call("snapshot")).accounts.length, 0);
      report.languages.push(language);
      console.log(
        JSON.stringify({ language, status: "passed", inferenceRequests: 0 }),
      );
    }
    // Real journal refresh tests content growth without a new model turn.
    await page.locator(".chat-follow-latest").click();
    await bottom();
    let releaseImage, imageRequested;
    const imageGate = new Promise((resolve) => {
      releaseImage = resolve;
    });
    const imageSeen = new Promise((resolve) => {
      imageRequested = resolve;
    });
    await page.route(
      "https://relay-qa.invalid/late-scroll.png",
      async (route) => {
        imageRequested();
        await imageGate;
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      },
    );
    await fs.appendFile(
      journal,
      JSON.stringify({
        id: randomUUID(),
        role: "assistant",
        kind: "message",
        at: Date.now(),
        text:
          "LATE_JOURNAL_FOLLOW\n\n" +
          "Layout grows. ".repeat(250) +
          "\n\n![late-scroll](https://relay-qa.invalid/late-scroll.png)",
      }) + "\n",
    );
    await page.getByText(/^LATE_JOURNAL_FOLLOW/).waitFor({ timeout: 15000 });
    await bottom();
    await Promise.race([
      imageSeen,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("Deferred image never entered the viewport")),
          5000,
        ),
      ),
    ]);
    releaseImage();
    await page.waitForFunction(
      () => document.querySelector('img[alt="late-scroll"]')?.naturalWidth > 0,
    );
    await bottom();
    await home();
    await fs.appendFile(
      journal,
      JSON.stringify({
        id: randomUUID(),
        role: "assistant",
        kind: "message",
        at: Date.now(),
        text: "LATE_JOURNAL_READING\n\n" + "Keep reading. ".repeat(250),
      }) + "\n",
    );
    await page.getByText(/^LATE_JOURNAL_READING/).waitFor({ timeout: 15000 });
    await frames();
    assert(
      (await top()) < 4,
      "New history does not pull the reader to the end",
    );
    report.checks = [
      "width and height resize",
      "native zoom",
      "composer growth and shrink",
      "inspector animation",
      "manual command expansion",
      "reading across settings",
      "animated return and wheel interruption",
      "app and system reduced motion",
      "journal updates follow or preserve reading",
      "deferred image decode (intercepted fixture, no imagegen inference)",
    ];
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    if (page)
      await page
        .screenshot({ path: path.join(output, "scroll-native-failed.png") })
        .catch(() => {});
    throw e;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(output, "scroll-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
