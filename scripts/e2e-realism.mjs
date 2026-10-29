import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { startTestServer } from "./test-server.mjs";
const out = resolve(process.env.REALISM_QA_OUT || "../../outputs/anant-v5");
mkdirSync(out, { recursive: true });
const server = await startTestServer(out),
  report = { checks: [], errors: [], captures: [], renderer: "", fps: 0 };
let browser;
const check = (name, pass, details) => {
  report.checks.push({ name, pass: !!pass, details });
  if (!pass) throw Error(name + ": " + JSON.stringify(details));
};
try {
  browser = await chromium.launch({
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(120000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (m) => {
    if (m.type() === "error") report.errors.push(m.text());
  });
  await page.goto(server.url + "/?skipIntro&quality=cinematic");
  await page.waitForFunction(() => window.__anant?.engine.fps.value > 0);
  await page.waitForTimeout(7000);
  report.renderer = await page.evaluate(() => {
    const gl = window.__anant.engine.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  });
  const shot = async (name) => {
    await page.screenshot({ path: join(out, name + ".png") });
    report.captures.push(name);
  };
  check(
    "default free flight",
    await page.evaluate(() => window.__anant.engine.rig.mode === "fly"),
  );
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("nexus");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const app = window.__anant;
    await app.intention("Summon a dragon");
    await app.queue;
    const dragon = app.state.objects.find((o) => o.kind === "dragon");
    await app.engine.realm.objects.get(dragon.id).built.ready;
  });
  const dragon = await page.evaluate(() => {
    const app = window.__anant,
      object = app.state.objects.find((o) => o.kind === "dragon"),
      e = app.engine.realm.objects.get(object.id);
    let worldSize;
    let meshes = 0,
      skins = 0,
      vertices = 0;
    e.built.root.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        vertices += o.geometry.attributes.position.count;
      }
      if (o.isSkinnedMesh) { skins++;o.computeBoundingBox();const posed=o.boundingBox.clone().applyMatrix4(o.matrixWorld);worldSize=posed.getSize(e.holder.position.clone()).toArray(); }
    });
    return {
      loaded: e.built.root.userData.assetLoaded,
      meshes,
      skins,
      vertices,
      floating: object.floating,
      worldSize,
    };
  });
  check(
    "authored dragon anatomy and skinning",
    dragon.loaded && dragon.skins > 0 && dragon.vertices > 10000 && dragon.worldSize[0] > 2 && dragon.worldSize[0] < 20,
    dragon,
  );
  await page.evaluate(() => {
    const a = window.__anant,
      id = a.state.objects.find((o) => o.kind === "dragon").id;
    a.engine.applyFocus("object", id);
  });
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("dragon");
  await page.keyboard.press("Escape");
  const pose = () =>
    page.evaluate(() => {
      const a = window.__anant,
        e = a.engine.realm.objects.get(
          a.state.objects.find((o) => o.kind === "dragon").id,
        );
      const result = [];
      e.built.root.traverse((o) => {
        if (o.isBone && result.length < 120)
          result.push(...o.quaternion.toArray());
      });
      return result;
    });
  const before = await pose();
  await page.waitForTimeout(600);
  const after = await pose();
  check(
    "skeletal flight animates",
    before.some((v, i) => Math.abs(v - after[i]) > 0.001),
  );
  await page.evaluate(() =>
    window.__anant.run([{ op: "set_time", frozen: true }], "gesture"),
  );
  const frozen = await pose();
  await page.waitForTimeout(500);
  check(
    "freeze stops skeletal animation",
    JSON.stringify(frozen) === JSON.stringify(await pose()),
  );
  await page.evaluate(() =>
    window.__anant.run([{ op: "set_time", frozen: false }], "gesture"),
  );
  await page.evaluate(async () => {
    const a = window.__anant;
    await a.intention("bring earth near blackhole");
    await a.queue;
  });
  await page.waitForTimeout(5000);
  check(
    "exact black-hole request executes",
    await page.evaluate(
      () => window.__anant.state.cosmos.blackHoleCompanion?.bodyId === "earth",
    ),
  );
  check(
    "planet is enabled in bent-ray renderer",
    await page.evaluate(
      () =>
        window.__anant.engine.realms.cosmos.bhMat.uniforms.uPlanetOn.value ===
        1,
    ),
  );
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("earth-black-hole");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const a = window.__anant;
    await a.intention("bring it closer");
    await a.queue;
  });
  check(
    "relative encounter adjustment",
    await page.evaluate(
      () => window.__anant.state.cosmos.blackHoleCompanion.distanceRs < 22,
    ),
  );
  await page.evaluate(async () => {
    const a = window.__anant;
    await a.intention("undo");
    await a.queue;
  });
  check(
    "encounter undo",
    await page.evaluate(
      () => window.__anant.state.cosmos.blackHoleCompanion.distanceRs === 22,
    ),
  );
  await page.evaluate(async () => {
    const a = window.__anant;
    await a.run(
      [
        { op: "cosmos_black_hole", show: false },
        { op: "go_to_realm", realm: "village" },
        { op: "set_environment", time_of_day: "day" },
      ],
      "gesture",
    );
    await a.engine.realms.village.assetsReady;
  });
  await page.waitForTimeout(5000);
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("village-day");
  await page.keyboard.press("Escape");
  report.fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let count = 0;
        const t = performance.now();
        const tick = () => {
          count++;
          if (performance.now() - t >= 4000)
            resolve(+((count * 1000) / (performance.now() - t)).toFixed(1));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  for (const id of [3, 5, 10].filter((id) =>
    existsSync(
      resolve("../../outputs/anant-limits/experiment-" + id + ".json"),
    ),
  )) {
    const original = JSON.parse(
      readFileSync(
        resolve("../../outputs/anant-limits/experiment-" + id + ".json"),
        "utf8",
      ),
    );
    await page.evaluate(async (reply) => {
      const a = window.__anant;
      if (!a.studio) await a.openStudio();
      a.studio.reply = reply;
      await a.studio.present(true);
    }, original);
    await page.waitForTimeout(5000);
    await shot("limit-" + id);
    const facts = await page.evaluate(() => {
      const s = window.__anant.studio,
        r = s.renderer;
      return {
        mode: r.rig.mode,
        colliders: r.colliders.length,
        objects: s.reply.plan.objects.length,
        effects: s.reply.plan.effects.map((e) => e.kind),
        description: s.reply.plan.description,
      };
    });
    report.checks.push({
      name: "rendered recorded live AI experiment " + id,
      pass: true,
      details: facts,
    });
  }
  const auditedFile = resolve(
    "../../outputs/anant-limits/droplet-with-capability-report.json",
  );
  if (existsSync(auditedFile)) {
    const audited = JSON.parse(readFileSync(auditedFile, "utf8"));
    await page.evaluate(async (reply) => {
      const studio = window.__anant.studio;
      studio.reply = reply;
      await studio.present(true);
    }, audited);
    check(
      "unsupported behaviour is visible after real generation",
      await page.locator(".experience-limitations").isVisible(),
    );
    await shot("capability-report");
    const authored = {
      ...audited,
      source: "template",
      prompt: "",
      limitations: [],
      plan: {
        ...audited.plan,
        title: "Authored creature integration check",
        description: "Authored test scene for the shared dragon asset.",
        environment: {
          ...audited.plan.environment,
          time: "day",
          weather: "clear",
        },
        objects: [
          {
            kind: "dragon",
            position: [0, 4, -12],
            scale: [1, 1, 1],
            color: "#bf6655",
            material: "stone",
            motion: "float",
          },
        ],
        effects: [],
      },
    };
    await page.evaluate(async (reply) => {
      const studio = window.__anant.studio;
      studio.reply = reply;
      await studio.present(true);
      studio.details.hidden = true;
      const r = studio.renderer;
      await r.creatures[0].ready;
      const center = r.rig.pos.clone().set(0, 8, -12);
      r.rig.setOrbit(
        center,
        center.clone().add(r.rig.pos.clone().set(12, 3, 14)),
      );
      r.rig.update(0, r.realm);
      r.rig.setFly();
    }, authored);
    await page.waitForTimeout(3000);
    check(
      "same skinned creature runs in Studio",
      await page.evaluate(
        () =>
          window.__anant.studio.renderer.creatures[0].root.userData.assetLoaded,
      ),
    );
    await page.getByRole("button", { name: "Cinema", exact: true }).click();
    await shot("studio-dragon");
    await page.keyboard.press("Escape");
  }
  check("no browser or shader errors", !report.errors.length, report.errors);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.errors.push(String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.stop();
  writeFileSync(join(out, "realism-qa.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
