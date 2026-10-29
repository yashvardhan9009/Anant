import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startTestServer } from "./test-server.mjs";

const out = resolve(process.env.NEXUS_QA_OUT || "../../outputs/anant-v6");
mkdirSync(out, { recursive: true });
const server = await startTestServer(out);
const report = {
  checks: [],
  errors: [],
  captures: [],
  settings: [],
  renderer: "",
  fps: 0,
};
let browser;
const check = (name, pass, details) => {
  report.checks.push({ name, pass: !!pass, details });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) throw Error(name + ": " + JSON.stringify(details));
};
try {
  browser = await chromium.launch({
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({
    viewport: { width: 1672, height: 960 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const monitor = (page) => {
    page.on("pageerror", (e) => report.errors.push(e.stack));
    page.on("console", (m) => {
      if (m.type() === "error") report.errors.push(m.text());
    });
  };
  monitor(page);
  await page.goto(server.url + "/?skipIntro&quality=cinematic");
  await page.waitForFunction(() => window.__anant?.engine.fps.value > 0);
  await page.waitForFunction(
    () =>
      window.__anant.engine.realm.scene.getObjectByName("Nexus monumental hall")
        ?.userData.assetsReady,
  );
  await page.waitForFunction(() =>
    window.__anant.engine.realm.scene.getObjectByName(
      "Scanned rock beneath the citadel",
    ),
  );
  await page.waitForTimeout(3500);
  report.renderer = await page.evaluate(() => {
    const gl = window.__anant.engine.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable";
  });
  const shot = async (name) => {
    await page.screenshot({ path: join(out, name + ".png") });
    report.captures.push(name);
  };
  check(
    "Free flight on arrival",
    await page.evaluate(() => window.__anant.engine.rig.mode === "fly"),
  );
  check(
    "Actual wet floor reflection target",
    await page.evaluate(() => {
      const mirror = window.__anant.engine.realm.scene.getObjectByName(
        "Wet marble planar reflection",
      );
      return mirror?.isReflector && mirror.getRenderTarget().width === 768;
    }),
  );
  const content = await page.evaluate(() => {
    const s = window.__anant.engine.realm.scene;
    let vertices = 0,
      meshes = 0;
    s.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        vertices += o.geometry.attributes.position.count;
      }
    });
    return {
      vertices,
      meshes,
      figure: !!s.getObjectByName("Scanned central stone figure"),
      rock: !!s.getObjectByName("Scanned rock beneath the citadel"),
    };
  });
  check(
    "Detailed hall, scan and vignette geometry",
    content.figure && content.rock && content.vertices > 100000,
    content,
  );
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("nexus-front");
  check(
    "Cinema hides gate labels",
    await page.evaluate(() =>
      [...document.querySelectorAll(".gate-label")].every(
        (el) =>
          getComputedStyle(el).visibility === "hidden" ||
          getComputedStyle(el).display === "none",
      ),
    ),
  );
  report.fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0,
          start = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - start < 3500) requestAnimationFrame(tick);
          else resolve(+((n * 1000) / (performance.now() - start)).toFixed(1));
        };
        requestAnimationFrame(tick);
      }),
  );
  const gatePicks = await page.evaluate(() => {
    const e = window.__anant.engine;
    return e.realms.nexus.gates.map((g) => {
      const p = g
        .localToWorld(g.position.clone().set(0, 8, 0))
        .project(e.camera);
      const pick = e.pick({ x: p.x, y: p.y });
      const anchor = g.localToWorld(g.userData.portalAnchor.clone());
      return {
        id: g.userData.gate,
        picked: pick.gate,
        inFrame: Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
        anchor: anchor.toArray(),
        height: e.realm.groundY(anchor.x, anchor.z),
      };
    });
  });
  for (const p of gatePicks)
    check(
      "Pick " + p.id + " through visible aperture",
      p.picked === p.id && p.inFrame && p.height === 0,
      p,
    );
  check(
    "Ray outside a circular window does not hit its invisible sky plane",
    await page.evaluate(() => {
      const e = window.__anant.engine,
        g = e.realms.nexus.gates[0],
        p = g.localToWorld(g.position.clone().set(0, 26, -8)).project(e.camera);
      return !e.pick({ x: p.x, y: p.y }).gate;
    }),
  );
  check(
    "Static hall reuses its shadow map",
    await page.evaluate(
      () => !window.__anant.engine.realms.nexus.key.shadow.autoUpdate,
    ),
  );
  // The large vignette background plane must never steal clicks outside its aperture.
  check(
    "Hidden scenery cannot steal gate clicks",
    await page.evaluate(() => {
      const g = window.__anant.engine.realms.nexus.gates[0],
        area = g.getObjectByName("Circular destination hit area");
      return (
        area.geometry.type === "CircleGeometry" &&
        area.material.colorWrite === false
      );
    }),
  );
  const y = await page.evaluate(() => window.__anant.engine.camera.position.y);
  await page.keyboard.down("e");
  await page.waitForTimeout(350);
  await page.keyboard.up("e");
  check(
    "Flight ascends smoothly",
    await page.evaluate(
      (y) => window.__anant.engine.camera.position.y > y + 0.5,
      y,
    ),
  );
  await page.evaluate(() => {
    const e = window.__anant.engine;
    e.rig.setFlight(e.camera.position.clone().set(-12, 5, 15), -0.27, 0.18);
  });
  await page.waitForTimeout(1500);
  await shot("nexus-side");
  await page.evaluate(() => {
    const e = window.__anant.engine;
    e.rig.setFlight(e.camera.position.clone().set(4, 3, 5), -0.16, 0.02);
  });
  await page.waitForTimeout(1500);
  await shot("nexus-materials");
  await page.evaluate(() => {
    const e = window.__anant.engine;
    e.placeCameraOnArrival("nexus");
  });
  await page.keyboard.press("Escape");
  // The click handler must place the real travel portal in front of the wider steps.
  await page.evaluate(() =>
    window.__anant.pickAction({ gate: "atom" }, "mouse"),
  );
  const travel = await page.evaluate(() => {
    const a = window.__anant,
      p = a.state.portals.find((p) => p.from === "nexus" && p.to === "atom"),
      g = a.engine.realms.nexus.gates.find((g) => g.userData.gate === "atom");
    const local = g.worldToLocal(g.position.clone().set(...p.position));
    return { local: local.toArray(), yaw: p.yaw, expectedYaw: g.rotation.y };
  });
  check(
    "Travel portal clears the steps and follows gate orientation",
    Math.abs(travel.local[2] - 5.2) < 0.02 &&
      Math.abs(travel.yaw - travel.expectedYaw) < 0.001,
    travel,
  );
  await page.evaluate(() =>
    window.__anant.pickAction({ gate: "atom" }, "mouse"),
  );
  await page.evaluate(() => window.__anant.queue);
  await page.waitForFunction(
    () =>
      window.__anant.state.activeRealm === "atom" &&
      !window.__anant.engine.transitioning,
  );
  check(
    "Gate opens and enters interactive Atom realm",
    await page.evaluate(() => window.__anant.engine.active === "atom"),
  );
  await page.evaluate(() =>
    window.__anant.run([{ op: "go_to_realm", realm: "nexus" }], "gesture"),
  );
  await page.waitForFunction(
    () =>
      window.__anant.engine.active === "nexus" &&
      !window.__anant.engine.transitioning,
  );
  check(
    "Return to redesigned Nexus",
    await page.evaluate(() => window.__anant.engine.realm.gates.length === 4),
  );
  await page.evaluate(() =>
    window.__anant.run([{ op: "set_time", frozen: true }], "gesture"),
  );
  const t = await page.evaluate(
    () => window.__anant.engine.realms.nexus.windows.clock.value,
  );
  await page.waitForTimeout(500);
  check(
    "Freeze stops vignette and effect clocks",
    await page.evaluate(
      (t) => window.__anant.engine.realms.nexus.windows.clock.value === t,
      t,
    ),
  );
  await page.evaluate(() =>
    window.__anant.run([{ op: "set_time", frozen: false }], "gesture"),
  );
  const walking = await page.evaluate(() => {
    const e = window.__anant.engine;
    e.rig.setWalk(e.camera.position.clone().set(3, 3, -2), 0, 0);
    return e.realm.groundY(3, -2) + e.realm.eyeHeight;
  });
  await page.waitForTimeout(1000);
  check(
    "Walking stands on raised dais",
    await page.evaluate(
      (y) => Math.abs(window.__anant.engine.camera.position.y - y) < 0.06,
      walking,
    ),
  );
  await page.evaluate(() => {
    const e = window.__anant.engine;
    const p = e.camera.position.clone().set(0, 2, -2);
    e.realm.constrainWalk(p);
    return e.rig.setFlight(p, 0, 0.2);
  });
  check(
    "Walking collision excludes the stone figure",
    await page.evaluate(
      () =>
        Math.hypot(
          window.__anant.engine.rig.pos.x,
          window.__anant.engine.rig.pos.z + 2,
        ) >= 0.97,
    ),
  );
  await page.evaluate(() =>
    window.__anant.engine.placeCameraOnArrival("nexus"),
  );
  await page.setViewportSize({ width: 820, height: 740 });
  await page.waitForTimeout(600);
  check(
    "Viewport resize remains valid",
    await page.evaluate(
      () => Math.abs(window.__anant.engine.camera.aspect - 820 / 740) < 0.001,
    ),
  );
  await shot("nexus-compact");
  await context.close();
  // Every tier compiles in the actual WebGL adapter, with reduced reflection budgets.
  for (const quality of ["performance", "balanced", "ultra"]) {
    const c = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      }),
      p = await c.newPage();
    monitor(p);
    await p.goto(server.url + "/?skipIntro&quality=" + quality);
    await p.waitForFunction(() => window.__anant?.engine.fps.value > 0);
    await p.waitForTimeout(3500);
    const stats = await p.evaluate(() => {
      const e = window.__anant.engine,
        m = e.realms.nexus.scene.getObjectByName(
          "Wet marble planar reflection",
        );
      return {
        fps: e.fps.value,
        shadow: e.renderer.shadowMap.enabled,
        reflection: m?.getRenderTarget().width ?? 0,
        flight: e.rig.mode,
        memory: e.renderer.info.memory,
      };
    });
    report.settings.push({ quality, ...stats });
    check(
      quality + " renders with its intended budget",
      stats.flight === "fly" &&
        (quality === "performance"
          ? stats.reflection === 0 && !stats.shadow
          : stats.reflection === (quality === "ultra" ? 1536 : 384)),
      stats,
    );
    await c.close();
  }
  check(
    "No browser or shader errors",
    report.errors.length === 0,
    report.errors,
  );
} catch (e) {
  report.failure = e.stack;
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await server.stop();
  report.ok =
    !report.failure &&
    report.checks.every((c) => c.pass) &&
    report.errors.length === 0;
  writeFileSync(join(out, "nexus-qa.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ok: report.ok,
      checks: report.checks.length,
      fps: report.fps,
      renderer: report.renderer,
      errors: report.errors.length,
    }),
  );
}
