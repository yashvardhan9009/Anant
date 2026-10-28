// Production browser checks. EXPERIENCE_LIVE=1 additionally calls the installed AI
// and public Wikipedia research; default uses an explicit deterministic fixture.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer } from "./test-server.mjs";
const live = process.env.EXPERIENCE_LIVE === "1",
  out = process.env.EXPERIENCE_QA_OUT || "test-results/experience";
mkdirSync(out, { recursive: true });
const server = await startTestServer(out, { offline: !live });
const report = {
  live,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  ok: false,
};
let browser;
const check = (name, value) => {
  report.checks.push({ name, pass: !!value });
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
  if (!value) throw Error(name);
};
try {
  browser = await chromium.launch({
    args:
      process.platform === "win32"
        ? ["--use-angle=d3d11", "--ignore-gpu-blocklist"]
        : [],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(180000);
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/Failed to load resource.*(?:404|500)/.test(m.text())
    )
      report.errors.push(m.text());
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/experience")) {
      try {
        const data = await response.json();
        console.log(
          JSON.stringify({
            api: data.source,
            model: data.model,
            title: data.plan?.title,
            reason: data.fallbackReason,
            ms: data.latencyMs,
          }),
        );
      } catch {}
    }
  });
  const url = `${server.url}/?skipIntro&quality=cinematic&studio`;
  await page.goto(url);
  await page.locator(".experience-studio canvas").waitFor();
  await page.waitForTimeout(12000);
  const studio = () => page.evaluate(() => window.__anant.studio.reply);
  check(
    "studio pauses the underlying world",
    await page.evaluate(
      () =>
        window.__anant.engine.suspended && document.querySelector("#hud").inert,
    ),
  );
  report.renderer = await page.evaluate(() => {
    const gl = window.__anant.studio.renderer.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  await page.screenshot({ path: join(out, "01-elements.png") });
  report.fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start > 3000)
            resolve(
              +((frames * 1000) / (performance.now() - start)).toFixed(1),
            );
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  check(
    "free flight is the default",
    await page.evaluate(
      () => window.__anant.studio.renderer.rig.mode === "fly",
    ),
  );
  const layout = JSON.stringify((await studio()).plan.objects);
  await page
    .getByRole("combobox", { name: "Scene lighting" })
    .selectOption("day");
  await page.waitForTimeout(4000);
  check(
    "daylight changes lighting without changing the scene layout",
    (await studio()).plan.environment.time === "day" &&
      JSON.stringify((await studio()).plan.objects) === layout,
  );
  await page.screenshot({ path: join(out, "11-daylight.png") });
  await page
    .getByRole("combobox", { name: "Scene lighting" })
    .selectOption("night");
  await page.waitForTimeout(1500);
  check(
    "night lighting is available",
    (await studio()).plan.environment.time === "night",
  );
  await page
    .getByRole("combobox", { name: "Scene lighting" })
    .selectOption("blue");
  await page.waitForTimeout(1500);
  await page.locator(".experience-canvas canvas").focus();
  const height = await page.evaluate(
    () => window.__anant.studio.renderer.camera.position.y,
  );
  await page.keyboard.down("e");
  await page.waitForTimeout(500);
  await page.keyboard.up("e");
  check(
    "flight can rise vertically",
    await page.evaluate(
      (h) => window.__anant.studio.renderer.camera.position.y > h + 0.5,
      height,
    ),
  );
  await page
    .getByRole("button", { name: "Flying · switch to walk", exact: true })
    .click();
  await page.waitForTimeout(1000);
  check(
    "walking restores human eye height",
    await page.evaluate(
      () =>
        Math.abs(window.__anant.studio.renderer.camera.position.y - 1.72) < 0.1,
    ),
  );
  await page
    .getByRole("button", { name: "Walking · switch to fly", exact: true })
    .click();
  await page.getByRole("button", { name: "Water", exact: true }).click();
  // Project the visible flame's base into the viewport, then perform a real click.
  const target = await page.evaluate(async () => {
    const s = window.__anant.studio,
      e = s.reply.plan.effects.find((e) => e.kind === "fire"),
      v = s.renderer.camera.position.clone();
    v.set(...e.position).project(s.renderer.camera);
    const r = s.renderer.renderer.domElement.getBoundingClientRect();
    return {
      x: r.left + ((v.x + 1) * r.width) / 2,
      y: r.top + ((1 - v.y) * r.height) / 2,
    };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(600);
  check(
    "water click extinguishes fire into steam",
    (await studio()).plan.effects.some((e) => e.kind === "steam") &&
      !(await studio()).plan.effects.some((e) => e.kind === "fire"),
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  check(
    "undo restores flame",
    (await studio()).plan.effects.some((e) => e.kind === "fire"),
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  check(
    "redo restores interaction",
    (await studio()).plan.effects.some((e) => e.kind === "steam"),
  );
  await page.getByRole("button", { name: "Pause time", exact: true }).click();
  check(
    "time can be frozen",
    await page.evaluate(() => window.__anant.studio.renderer.frozen),
  );
  await page.getByRole("button", { name: "Resume time", exact: true }).click();
  await page.locator(".experience-canvas canvas").focus();
  const z = await page.evaluate(
    () => window.__anant.studio.renderer.camera.position.z,
  );
  await page.keyboard.down("w");
  await page.waitForTimeout(1000);
  await page.keyboard.up("w");
  check(
    "first person movement works",
    await page.evaluate(
      (z) => window.__anant.studio.renderer.camera.position.z < z - 0.8,
      z,
    ),
  );
  await page.keyboard.down("w");
  await page.getByLabel("Describe your reality").focus();
  check(
    "editing stops camera motion",
    await page.evaluate(
      () => window.__anant.studio.renderer.rig.keys.size === 0,
    ),
  );
  await page.keyboard.up("w");
  if (!live) {
    const fixture = await studio();
    fixture.source = "ai";
    fixture.model = "TEST FIXTURE";
    fixture.plan.title = "Fixture sanctuary";
    await page.route("**/api/experience", (r) => r.fulfill({ json: fixture }));
  }
  await page.getByLabel("Describe your reality").focus();
  await page.getByRole("button", { name: "Fire & water", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".experience-status")
        ?.textContent.includes("Saved with this world"),
    null,
    { timeout: 180000 },
  );
  const created = await studio();
  check(
    live
      ? "installed AI creates a validated scene"
      : "fixture scene is rendered",
    created.source === "ai" && created.plan.objects.length > 0,
  );
  report.generated = created;
  writeFileSync(
    join(out, "generated-scene.json"),
    JSON.stringify(created, null, 2),
  );
  await page.waitForTimeout(4500);
  await page.screenshot({ path: join(out, "02-ai-sanctuary.png") });
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await page.screenshot({ path: join(out, "03-cinema.png") });
  await page.keyboard.press("Escape");
  check(
    "cinema restores controls",
    await page
      .getByRole("button", { name: "Make it happen", exact: true })
      .isVisible(),
  );
  await page
    .getByLabel("Describe your reality")
    .fill("Add a violet portal to the right of the sanctuary");
  await page
    .getByRole("button", { name: "Make it happen", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".experience-status")
        ?.textContent.includes("Saved with this world"),
    null,
    { timeout: 180000 },
  );
  if (live)
    check(
      "AI refinement adds a portal",
      (await studio()).plan.effects.some((e) => e.kind === "portal"),
    );
  if (live) {
    await page
      .getByRole("button", { name: "Ancient Rome", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".experience-status")
          ?.textContent.includes("Saved with this world"),
      null,
      { timeout: 180000 },
    );
    const history = await studio();
    report.history = history;
    check(
      "history has references and reconstruction label",
      !!history.plan.reconstruction && history.sources.length > 0,
    );
    await page
      .getByRole("button", { name: "Scene notes", exact: true })
      .click();
    check(
      "reference links are visible",
      (await page.locator(".experience-details a").count()) > 0,
    );
    await page.screenshot({ path: join(out, "04-history.png") });
    await page
      .getByRole("button", { name: "Scene notes", exact: true })
      .click();
  }
  const saved = await studio();
  await page.waitForTimeout(1200);
  await page.reload();
  await page.locator(".experience-studio canvas").waitFor();
  check(
    "scene and sources survive reload",
    JSON.stringify((await studio()).plan) === JSON.stringify(saved.plan),
  );
  // Cancel and failure paths must never overwrite the saved scene.
  await page.unroute("**/api/experience");
  await page.route("**/api/experience", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route
      .fulfill({ json: { ...saved, plan: { ...saved.plan, title: "STALE" } } })
      .catch(() => {});
  });
  await page
    .getByLabel("Describe your reality")
    .fill("Make the entire scene purple");
  await page
    .getByRole("button", { name: "Make it happen", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(2000);
  check(
    "cancelled generation cannot replace the scene",
    (await studio()).plan.title !== "STALE",
  );
  await page.unroute("**/api/experience");
  await page.route("**/api/experience", (r) =>
    r.fulfill({
      json: {
        ...saved,
        source: "template",
        fallbackReason: "AI unavailable. Current scene preserved.",
      },
    }),
  );
  await page
    .getByRole("button", { name: "Make it happen", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".experience-status")
      ?.textContent.includes("AI unavailable"),
  );
  check(
    "fallback never pretends generation succeeded",
    (await studio()).plan.title === saved.plan.title,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  check(
    "mobile has no horizontal overflow",
    await page.evaluate(
      () =>
        document.querySelector(".experience-studio").scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: join(out, "05-mobile.png") });
  await page.keyboard.press("Escape");
  check(
    "closing studio restores the world",
    await page.evaluate(
      () =>
        !window.__anant.engine.suspended &&
        !document.querySelector("#hud").inert,
    ),
  );
  check("no browser or shader errors", report.errors.length === 0);
  report.ok = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.stop();
  writeFileSync(
    join(out, "experience-qa.json"),
    JSON.stringify(report, null, 2),
  );
}
