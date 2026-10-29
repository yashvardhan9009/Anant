import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startTestServer } from "./test-server.mjs";
const out = resolve(process.env.ENVIRONMENT_QA_OUT || "../../outputs/anant-v7");
mkdirSync(out, { recursive: true });
const server = await startTestServer(out),
  report = { checks: [], errors: [], captures: [], samples: [], renderer: "" };
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
      viewport: { width: 1440, height: 900 },
    }),
    page = await context.newPage();
  page.setDefaultTimeout(120000);
  const monitor = (p) => {
    p.on("pageerror", (e) => report.errors.push(e.stack));
    p.on("console", (m) => {
      if (m.type() === "error") report.errors.push(m.text());
    });
  };
  monitor(page);
  const shot = async (name) => {
    await page.screenshot({ path: join(out, name + ".png") });
    report.captures.push(name);
  };
  const sample = async (name) => {
    const fps = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const start = performance.now();
          let n = 0;
          const step = () => {
            n++;
            if (performance.now() - start < 2500) requestAnimationFrame(step);
            else
              resolve(+((n * 1000) / (performance.now() - start)).toFixed(1));
          };
          requestAnimationFrame(step);
        }),
    );
    report.samples.push({ name, fps, viewport: [1440, 900] });
  };
  const camera = async (p, yaw, pitch) =>
    page.evaluate(
      ({ p, yaw, pitch }) => {
        const e = window.__anant.engine;
        e.rig.setFlight(e.camera.position.clone().set(...p), yaw, pitch);
      },
      { p, yaw, pitch },
    );
  await page.goto(server.url + "/?skipIntro&quality=cinematic");
  await page.waitForFunction(() => window.__anant?.engine.fps.value > 0);
  report.renderer = await page.evaluate(() => {
    const gl = window.__anant.engine.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  });
  check(
    "Nexus remains operational with the shared material changes",
    await page.evaluate(() => window.__anant.engine.realm.gates.length === 4),
  );
  const response = await page.request.get(
    server.url + "/assets/detail-v1/cobblestone_floor_01/height.webp",
  );
  check(
    "Versioned displacement has correct media headers",
    response.ok() &&
      response.headers()["content-type"] === "image/webp" &&
      response.headers()["cache-control"].includes("immutable"),
  );
  const manifest = await page.request.get(server.url + "/assets/manifest.json");
  check(
    "Asset manifest can be revalidated",
    manifest.headers()["cache-control"] === "no-cache",
  );
  await page.evaluate(() =>
    window.__anant.run(
      [
        { op: "go_to_realm", realm: "village" },
        { op: "set_environment", time_of_day: "day", weather: "clear" },
      ],
      "gesture",
    ),
  );
  await page.evaluate(() => window.__anant.engine.realms.village.assetsReady);
  await page.evaluate(() =>
    Promise.all(window.__anant.engine.realms.village.characterLoads),
  );
  await page.waitForTimeout(3000);
  await camera([2.5, 2, 22], 0, 0.01);
  await page.evaluate(() => window.__anant.hud.toggleCinema(true));
  await page.waitForTimeout(800);
  await shot("village-day");
  await sample("Village daylight");
  const village = await page.evaluate(() => {
    const e = window.__anant.engine,
      r = e.realm,
      c = r.scene.getObjectByName("Physical village cobbles");
    let cobbles = 0,
      houses = 0;
    const wallWidths = [];
    c?.traverse((o) => {
      if (o.isInstancedMesh) cobbles += o.count;
    });
    r.scene.traverse((o) => {
      if (o.name === "Timber dwelling") houses++;
    });
    const gl = e.renderer.getContext(),
      programs = e.renderer.info.programs.map(
        (p) => gl.getShaderSource(p.fragmentShader) || "",
      );
    return {
      cobbles,
      houses,
      reliefPrograms: programs.filter(
        (s) => s.includes("reliefHeight") && s.includes("reliefUV"),
      ).length,
      worldProjection: programs.some(
        (s) => s.includes("stoneWorld") && s.includes("normalMap"),
      ),
      shadowWidth: r.sun.shadow.camera.right - r.sun.shadow.camera.left,
      lodGroups: r.foliageLOD.length,
      flight: e.rig.mode,
    };
  });
  check(
    "Rounded foreground cobbles are real geometry",
    village.cobbles > 3000,
    village,
  );
  check(
    "Dwellings retain their four-faced architecture",
    village.houses >= 10,
    village,
  );
  check(
    "Source displacement shader compiled in the real adapter",
    village.reliefPrograms > 0,
    village,
  );
  check(
    "Near vegetation has spatial LOD groups",
    village.lodGroups >= 4,
    village,
  );
  check(
    "Focused moving shadows and default flight",
    village.shadowWidth === 46 && village.flight === "fly",
    village,
  );
  await camera([4.2, 0.7, 12], 0, -0.16);
  await page.waitForTimeout(700);
  await shot("cobbles-close");
  await page.evaluate(() =>
    window.__anant.run(
      [{ op: "set_environment", time_of_day: "night", weather: "rain" }],
      "gesture",
    ),
  );
  await camera([2.5, 2, 19], 0, 0.08);
  await page.waitForTimeout(1500);
  await shot("village-night");
  check(
    "Real lamp emitters respond to night",
    await page.evaluate(() =>
      window.__anant.engine.realm.lampFlames.every(
        (m) => m.emissiveIntensity > 1,
      ),
    ),
  );
  await page.evaluate(() =>
    window.__anant.run(
      [
        { op: "set_environment", time_of_day: "day", weather: "clear" },
        {
          op: "spawn_object",
          kind: "floating_island",
          position: [-3, 12, -30],
          scale: 2,
          floating: true,
        },
        {
          op: "spawn_object",
          kind: "castle",
          position: [-3, 12.65, -30],
          scale: 1.5,
          floating: true,
        },
        {
          op: "spawn_object",
          kind: "tower",
          position: [11, 6, -33],
          scale: 1,
          floating: true,
        },
      ],
      "gesture",
    ),
  );
  await page.waitForTimeout(3500);
  await page.evaluate(() =>
    Promise.all(
      [...window.__anant.engine.realm.objects.entries.values()].map(
        (e) => e.built.ready,
      ),
    ),
  );
  await camera([14, 14, 0], 0.48, 0.02);
  await page.waitForTimeout(1500);
  await shot("citadel-island");
  const objects = await page.evaluate(() => {
    const e = window.__anant.engine,
      entries = [...e.realm.objects.entries.values()],
      castle = entries.find((x) => x.obj.kind === "castle"),
      island = entries.find((x) => x.obj.kind === "floating_island");
    let verts = 0;
    castle.built.root.traverse((o) => {
      if (o.isMesh) verts += o.geometry.attributes.position.count;
    });
    const geo=island.built.root.children[0].geometry,p=geo.attributes.position,n=geo.attributes.normal;
    let outward=0;
    for(let i=0;i<p.count;i++)if(p.getX(i)*n.getX(i)+p.getZ(i)*n.getZ(i)>0)outward++;
    return {
      citadel: castle.built.root.name,
      verts,
      ready: castle.built.root.userData.detailReady,
      islandVertices:
        island.built.root.children[0].geometry.attributes.position.count,
      islandOutward:outward/p.count,
      waterfall: island.built.root.children.some(
        (o) => o.material?.isShaderMaterial && o.material.uniforms.uTime,
      ),
    };
  });
  check(
    "Citadel replaces the old primitive keep",
    objects.citadel === "Masonry citadel" &&
      objects.ready &&
      objects.verts > 15000,
    objects,
  );
  check(
    "Island rock faces point outward and water flows",
    objects.islandVertices > 1000 && objects.waterfall && objects.islandOutward>.99,
    objects,
  );
  await page.evaluate(() => window.__anant.hud.toggleCinema(false));
  await page.evaluate(() => window.__anant.openStudio());
  await page.waitForTimeout(6000);
  const fixture = await page.evaluate(() => {
    const base = structuredClone(window.__anant.studio.reply);
    base.source = "template";
    base.plan.title = "Forest hamlet · graphics validation";
    base.plan.description = "Authored rendering fixture, not an AI generation.";
    base.plan.environment = {
      ground: "grass",
      time: "golden",
      weather: "clear",
      sky: "#7f9ba7",
      aurora: false,
    };
    const item = (kind, position, scale, material, color) => ({
      kind,
      position,
      scale,
      material,
      color,
      motion: "still",
      rotation: 0,
    });
    base.plan.objects = [
      item("house", [-6, 0, -8], [1.1, 1.1, 1.1], "wood", "#978a74"),
      item("house", [6, 0, -10], [1.15, 1.15, 1.15], "stone", "#aba99b"),
      item("arch", [0, 0, -22], [2.3, 2.3, 1.8], "stone", "#9a9889"),
      ...[-1, 1].flatMap((side) =>
        [0, 1, 2].map((i) =>
          item(
            "tree",
            [side * (13 + i * 3), 0, -12 - i * 7],
            [1.2, 1.3, 1.2],
            "wood",
            "#63745c",
          ),
        ),
      ),
      item("firepit", [-2, 0, -5], [1.4, 1.4, 1.4], "stone", "#8e8c82"),
    ];
    base.plan.effects = [
      { kind: "fire", position: [-2, 0.3, -5], size: 1, color: "#ff9b45" },
      { kind: "water", position: [3, 0.3, -8], size: 1.3, color: "#87b8ca" },
    ];
    return base;
  });
  await page.evaluate(async (reply) => {
    const s = window.__anant.studio;
    s.reply = reply;
    await s.present(true);
  }, fixture);
  await page.waitForFunction(
    () =>
      window.__anant.studio.renderer.scene.getObjectByName(
        "Contextual environment dressing",
      )?.userData.ready,
  );
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Cinema", exact: true }).click();
  await shot("forest-hamlet");
  const studio = await page.evaluate(() => {
    const r = window.__anant.studio.renderer;
    const s = r.scene,
      gl = r.renderer.getContext();
    return {
      masonry: !!s.getObjectByName("Masonry dwelling"),
      timber: !!s.getObjectByName("Timber dwelling"),
      materials: r.renderer.info.programs.map(
        (p) => gl.getShaderSource(p.fragmentShader) || "",
      ),
      flight: r.rig.mode,
      shadow: r.sun.shadow.camera.right - r.sun.shadow.camera.left,
    };
  });
  check(
    "Studio uses detailed masonry and timber dwellings",
    studio.masonry && studio.timber,
  );
  check(
    "Terrain normal and roughness projections compile",
    studio.materials.some(
      (s) => s.includes("geoPosition") && s.includes("texture2D(normalMap"),
    ),
  );
  check(
    "World-mapped stone normals compile",
    studio.materials.some(
      (s) => s.includes("stoneWorld") && s.includes("texture2D(normalMap"),
    ),
  );
  check(
    "Studio keeps default flight and a focused shadow map",
    studio.flight === "fly" && studio.shadow === 44,
  );
  await sample("Studio forest hamlet");
  await page.evaluate(() => {
    const r = window.__anant.studio.renderer;
    r.rig.setFlight(r.camera.position.clone().set(-13, 5, 7), -0.4, 0.04);
  });
  await page.waitForTimeout(800);
  await shot("forest-side");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Flying · switch to walk", exact: true })
    .click();
  await page.waitForTimeout(1000);
  check(
    "Walking follows the current terrain height",
    await page.evaluate(() => {
      const r = window.__anant.studio.renderer,
        p = r.camera.position;
      return Math.abs(p.y - r.terrainHeight(p.x, p.z) - 1.72) < 0.08;
    }),
  );
  await page
    .getByRole("button", { name: "Walking · switch to fly", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause time", exact: true }).click();
  const time = await page.evaluate(() => window.__anant.studio.renderer.time);
  await page.waitForTimeout(300);
  check(
    "Pause still freezes phenomena",
    await page.evaluate((t) => window.__anant.studio.renderer.time === t, time),
  );
  await page.getByRole("button", { name: "Resume time", exact: true }).click();
  for (const ground of ["sand", "snow"]) {
    const next = structuredClone(fixture);
    next.plan.environment = { ...next.plan.environment, ground, time: "day" };
    next.plan.objects = [];
    next.plan.effects = [];
    next.plan.title = "Source " + ground + " rendering fixture";
    await page.evaluate(async (reply) => {
      const s = window.__anant.studio;
      s.reply = reply;
      await s.present(true);
    }, next);
    await page.waitForTimeout(3000);
    const maps = await page.evaluate(() => {
      const r = window.__anant.studio.renderer;
      const list = [];
      r.scene.traverse((o) => {
        if (o.isMesh && o.material.map?.image?.width === 2048)
          list.push(
            o.material.map.image.currentSrc || o.material.map.image.src || "",
          );
      });
      return list;
    });
    check(
      "Source " + ground + " material loads",
      maps.some((s) => s.includes(ground === "sand" ? "sand_01" : "snow_02")),
      maps,
    );
    await page.getByRole("button", { name: "Cinema", exact: true }).click();
    await shot(ground + "-landscape");
    await page.keyboard.press("Escape");
  }
  await context.close();
  for (const quality of ["performance", "balanced", "ultra"]) {
    const c = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      }),
      p = await c.newPage();
    monitor(p);
    await p.goto(server.url + "/?skipIntro&quality=" + quality + "&studio");
    await p.waitForFunction(() => window.__anant?.studio?.renderer);
    await p.waitForTimeout(6000);
    const data = await p.evaluate(() => {
      const r = window.__anant.studio.renderer;
      const widths = [];
      r.scene.traverse((o) => {
        if (o.isMesh && o.material.map?.image?.width)
          widths.push(o.material.map.image.width);
      });
      return {
        widths,
        mode: r.rig.mode,
        programs: r.renderer.info.programs.length,
      };
    });
    check(
      quality + " retains a working render path",
      data.mode === "fly" && data.programs > 2,
      data,
    );
    await c.close();
  }
  check(
    "No WebGL, shader or browser errors",
    report.errors.length === 0,
    report.errors,
  );
} catch (e) {
  report.failure = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  if (browser) await browser.close();
  await server.stop();
  report.ok =
    !report.failure &&
    report.checks.every((c) => c.pass) &&
    report.errors.length === 0;
  writeFileSync(
    join(out, "environment-qa.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      ok: report.ok,
      checks: report.checks.length,
      errors: report.errors.length,
      samples: report.samples,
    }),
  );
}
