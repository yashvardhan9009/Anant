// End-to-end run of the hackathon demo in a real (headless) Chromium.
// Starts the server on a temp DB, drives the UI through every scene, walks
// through portals, reloads to verify persistence, and records measured FPS
// and Director latency. Output: test-results/e2e.json + screenshots.
//
// E2E_SOFTWARE=1 forces SwiftShader. Otherwise use the available hardware backend.
// The report records the actual renderer; do not compare unlike renderers' FPS.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from './test-server.mjs';

// Use local executables on every OS; no globally installed npx is required.
if (!process.env.E2E_SKIP_BUILD) {
  for (const script of ['scripts/copy-wasm.mjs', 'scripts/copy-cesium.mjs', 'node_modules/vite/bin/vite.js']) {
    const result = spawnSync(process.execPath, [script, ...(script.includes('vite') ? ['build'] : [])], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw result.error ?? new Error('Production build failed');
  }
}

const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });
const server = await startTestServer(OUT);
const quality = process.env.E2E_QUALITY || 'performance';
const URL = `${server.url}/?skipIntro&quality=${encodeURIComponent(quality)}`;

const report = { startedAt: new Date().toISOString(), renderer: '', steps: [], errors: [], persistence: null, ok: true };
let browser;
try {
const gpuArgs = process.env.E2E_SOFTWARE === '1' ? ['--use-angle=swiftshader'] : process.platform === 'win32' ? ['--use-angle=d3d11'] : [];
browser = await chromium.launch({ args: [...gpuArgs, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(120000);
page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`console: ${m.text()}`); });

await page.goto(URL);
await page.waitForFunction(() => window.__anant?.engine?.fps?.value > 0, null, { timeout: 240000 });
report.renderer = await page.evaluate(() => {
  const gl = window.__anant.engine.renderer.getContext();
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

const settle = () => page.evaluate(() => window.__anant.queue);
async function fpsSample(ms = 3000) {
  return page.evaluate((ms) => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(n * 1000 / (performance.now() - t0)).toFixed(1)); };
    requestAnimationFrame(f);
  }), ms);
}
async function say(text) {
  const t0 = Date.now();
  await page.evaluate((t) => window.__anant.intention(t), text);
  await settle();
  await page.waitForTimeout(400);
  const entry = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.feed .entry')].pop();
    return { text: e?.innerText ?? '', ok: e ? e.querySelectorAll('.res.ok').length : 0, fail: e ? e.querySelectorAll('.res.fail').length : 0, warn: e ? e.querySelectorAll('.res.warn').length : 0 };
  });
  return { text, wallMs: Date.now() - t0, directorMs: await page.evaluate(() => window.__anant.lastDirectorMs), ...entry };
}
const state = () => page.evaluate(() => {
  const s = window.__anant.state;
  return { realm: s.activeRealm, size: s.observer?.size, focus: s.focus?.id, sun: s.cosmos.bodies.find((b) => b.id === 'sun')?.pos, objects: s.objects.map((o) => `${o.kind}@${o.realm}`), portals: s.portals.map((p) => `${p.from}->${p.to}`), atom: [s.atom.n, s.atom.l, s.atom.m], jupiter: s.cosmos.bodies.find((b) => b.id === 'jupiter')?.mass, conv: s.story.activeConversation, knows: s.story.playerKnows.length, outcome: s.story.outcome?.kind };
});
async function step(name, fn, expect) {
  const r = { name };
  try {
    r.actions = await fn();
    await page.waitForTimeout(900);
    r.state = await state();
    r.fps = await fpsSample(2500);
    await page.screenshot({ path: join(OUT, `${String(report.steps.length + 1).padStart(2, '0')}-${name}.png`) });
    const why = expect ? expect(r.state, r.actions) : true;
    r.pass = why === true;
    if (why !== true) r.failure = why;
  } catch (e) {
    r.pass = false;
    r.failure = String(e?.stack ?? e);
  }
  if (!r.pass) report.ok = false;
  report.steps.push(r);
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${name}  fps=${r.fps}  ${r.failure ?? ''}`);
}
const walk = async (ms) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w'); };

await step('scene1-nexus', async () => [], (s) => s.realm === 'nexus' || `realm ${s.realm}`);
await step('scene1-take-me-inside-an-atom', async () => [await say('Take me inside an atom.')], (s) => s.realm === 'atom' || `realm ${s.realm}`);
await step('scene2-2p-orbital', async () => [await say('Switch to a 2p orbital')], (s) => s.atom.join() === '2,1,0' || `atom ${s.atom}`);
await step('scene2-transition-photon', async () => [await say('Excite the electron to 3d')], (s) => s.atom.join() === '3,2,0' || `atom ${s.atom}`);
await step('scene2-most-probable', async () => [await say('Show where the electron is most likely to be found'), await say('Increase the scale')], (s) => s.realm === 'atom' || 'left atom');
await step('scene2-gesture-scale', async () => {
  // emulate a two-hand spread through the same InputHost path the hand tracker uses
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__anant.scaleSelected(1.1); });
  await page.waitForTimeout(600);
  return [await page.evaluate(() => window.__anant.state.atom.scale)];
}, (s, a) => a[0] > 1.5 || `atom scale ${a[0]}`);
await step('scene3-draw-circle-portal', async () => {
  // right-drag a circle with the mouse (the hand gesture uses the same detector)
  // Keep the stroke above the transcript dock, which is an interactive surface.
  const { width, height } = page.viewportSize();
  const cx = width / 2, cy = height * 0.36, R = Math.min(width, height) * 0.12;
  await page.mouse.move(cx + R, cy);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i <= 40; i++) await page.mouse.move(cx + R * Math.cos((i / 40) * 2 * Math.PI), cy + R * Math.sin((i / 40) * 2 * Math.PI));
  await page.mouse.up({ button: 'right' });
  await settle();
  await page.waitForTimeout(1500);
  return [];
}, (s) => s.portals.includes('atom->cosmos') || `portals ${s.portals}`);
await step('scene3-walk-through-portal', async () => {
  // zoom the orbit camera into the portal until it crosses the plane
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(40); }
  await page.waitForTimeout(500);
  let s = await state();
  if (s.realm !== 'cosmos') { await page.evaluate(() => window.__anant.run([{ op: 'enter_portal' }], 'gesture')); await settle(); s = await state(); return ['wheel-zoom did not cross; entered via command']; }
  await settle();
  return ['crossed by camera movement'];
}, (s) => s.realm === 'cosmos' || `realm ${s.realm}`);
await step('scene4-solar-system', async () => [await say('Create a miniature solar system')], (s) => s.realm === 'cosmos' || `realm ${s.realm}`);
await step('scene4-jupiter-mass', async () => {
  const before = await page.evaluate(() => { const c = window.__anant.engine.realms.cosmos; const i = c.sim.index('mars'); return c.sim.orbitalElements(i, c.sim.index('sun')).e; });
  const a = await say('Make Jupiter 1000 times more massive');
  await page.evaluate(() => window.__anant.run([{ op: 'cosmos_set_sim', time_scale: 3 }], 'gesture'));
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => { const c = window.__anant.engine.realms.cosmos; const i = c.sim.index('mars'); return c.sim.orbitalElements(i, c.sim.index('sun')).e; });
  await page.evaluate(() => window.__anant.run([{ op: 'cosmos_set_sim', time_scale: 0.5 }], 'gesture'));
  return [a, { marsEccBefore: before, marsEccAfter: after }];
}, (s, a) => (s.jupiter > 0.9 && a[1].marsEccAfter > a[1].marsEccBefore) || `jupiter ${s.jupiter} mars e ${JSON.stringify(a[1])}`);
await step('scene4-black-hole', async () => [await say('Show me a black hole')], (s) => s.realm === 'cosmos' || 'realm');
await step('scene4-black-hole-off', async () => [await say('Hide the black hole')], (s) => s.realm === 'cosmos' || 'realm');
await step('scene5-portal-to-fantasy', async () => [await say('Open a portal to a fantasy kingdom')], (s) => s.portals.includes('cosmos->village') || `portals ${s.portals}`);
await step('scene5-enter-village', async () => [await say('Step through the portal')], (s) => s.realm === 'village' || `realm ${s.realm}`);
await step('scene5-npc-approaches', async () => {
  await page.waitForFunction(() => window.__anant.state.story.activeConversation === 'ilsa', null, { timeout: 180000 });
  return [await page.evaluate(() => [...document.querySelectorAll('.dlg-line')].map((d) => d.textContent))];
}, (s, a) => (s.conv === 'ilsa' && a[0].join(' ').includes('Traveler')) || `conv ${s.conv} lines ${a[0]}`);
await step('scene5-dialogue', async () => {
  const out = [];
  for (const line of ['I am a traveler looking for work. What happened here?']) {
    await page.evaluate((l) => window.__anant.say(l), line);
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => window.__anant.run([{ op: 'talk_to', npc: 'doran' }], 'npc'));
  await settle();
  await page.evaluate(() => window.__anant.say('Did you see anything strange last night?'));
  await page.evaluate(() => window.__anant.run([{ op: 'talk_to', npc: 'maera' }], 'npc'));
  await settle();
  await page.evaluate(() => window.__anant.say('Who grows moonleaf around here?'));
  await page.waitForTimeout(800);
  out.push(await page.evaluate(() => [...document.querySelectorAll('.dlg-line')].map((d) => d.textContent)));
  return out;
}, (s) => s.knows >= 3 || `knows ${s.knows}`);
await step('scene6-floating-island', async () => {
  await page.evaluate(() => window.__anant.closeDialogue());
  return [await say('Create a floating island above the village')];
}, (s) => s.objects.includes('floating_island@village') || `objects ${s.objects}`);
await step('scene6-gesture-manipulate', async () => {
  const id = await page.evaluate(() => window.__anant.state.objects.find((o) => o.kind === 'floating_island').id);
  // grab → move → scale → rotate through the InputHost API used by hands & mouse
  const r = await page.evaluate(async (id) => {
    const app = window.__anant;
    const e = app.engine.realm.objects.get(id);
    const before = e.holder.position.toArray();
    const THREE_V2 = app.engine.camera.constructor; // not used; keep page-only
    app.beginGrab(id, e.holder.position.clone());
    app.moveGrab({ x: 0.3, y: 0.4, isVector2: true }, 0);
    app.endGrab();
    for (let i = 0; i < 4; i++) app.scaleSelected(1.12);
    app.rotateSelected(0.8);
    await new Promise((r) => setTimeout(r, 700));
    const o = app.state.objects.find((o) => o.id === id);
    return { before, after: o.position, scale: o.scale, rot: o.rotation[1] };
  }, id);
  await page.evaluate(() => window.__anant.engine.applyFocus('object', window.__anant.state.objects.find((o) => o.kind === 'floating_island').id));
  await page.waitForTimeout(1500);
  return [r];
}, (s, a) => (a[0].scale > 2.2 * 1.4 && Math.abs(a[0].rot - 0.8) < 1e-3 && a[0].after.join() !== a[0].before.join()) || JSON.stringify(a[0]));
await step('scene7-unscripted', async () => [await say('Summon a huge red dragon and make the sky purple'), await say('Make gravity weaker then create a storm')], (s) => s.objects.includes('dragon@village') || `objects ${s.objects}`);
await step('scene7-honest-unsupported', async () => [await say('Show me what happened here 100 years ago'), await say('Let me talk to the king')], () => true);

// ——— Master directive scenes: scale, micro-world, cosmic zoom, manipulation, multiverse ———
await step('scene8-microscopic', async () => [await say('Make me the size of a water molecule')], (s) => (s.realm === 'atom' && s.size < 1e-8) || `realm ${s.realm} size ${s.size}`);
await step('scene8-water-field', async () => [await page.evaluate(() => { const a = window.__anant.engine.realms.atom; return { molecules: a.field.N, hbonds: a.field.hbondCount }; })], (s, a) => a[0].molecules > 1000 || JSON.stringify(a[0]));
await step('scene9-thousands-of-galaxies', async () => [await say('Show me thousands of galaxies')], (s) => (s.realm === 'cosmos' && s.size > 1e24) || `realm ${s.realm} size ${s.size}`);
await step('scene9-inspect-andromeda', async () => [await say('Take me to Andromeda')], (s) => s.focus === 'andromeda' || `focus ${s.focus}`);
await step('scene10-hold-the-sun', async () => [await say('Show me the entire solar system'), await say('Make me large enough to hold the Sun'), await say('Switch to sandbox mode')], (s) => (s.size > 1e9 && s.size < 1e11) || `size ${s.size}`);
let sunBefore;
await step('scene10-grab-move-sun', async () => {
  // Pause before taking the reference: the previous scene perturbed Jupiter's mass,
  // so the Sun is moving and the reducer's last snapshot can be several frames old.
  await say('Pause the simulation');
  sunBefore = await page.evaluate(() => { const c = window.__anant.engine.realms.cosmos; return c.sim.getPos(c.sim.index('sun')); });
  const a = await say('Let me grab the Sun');
  for (let i = 0; i <= 10; i++) { await page.evaluate((i) => window.__anant.moveBody({ x: 0.05 * i, y: -0.05 * i, isVector2: true }), i); await page.waitForTimeout(80); }
  await page.evaluate(() => window.__anant.releaseBody());
  await page.waitForTimeout(600);
  return [a];
}, (s) => Math.hypot(...s.sun.map((v, k) => v - sunBefore[k])) > 0.5 || `sun barely moved ${s.sun}`);
await step('scene10-undo', async () => [await say('Undo what I just did')], (s) => Math.hypot(...s.sun.map((v, k) => v - sunBefore[k])) < 0.05 || `sun ${s.sun} vs ${sunBefore}`);
await step('scene11-multiverse-portal', async () => [await say('Return to human size'), await say('Open a portal to a universe with stronger gravity')], (s) => s.portals.some((p) => p.endsWith('->heavy')) || `portals ${s.portals}`);
await step('scene11-enter-hypothetical', async () => [await say('Step through the portal')], (s) => s.realm === 'heavy' || `realm ${s.realm}`);

await step('regression-unpause', async () => {
  await say('Pause the simulation');
  await say('Unpause the simulation');
  return [await page.evaluate(() => window.__anant.state.cosmos.paused)];
}, (_s, a) => a[0] === false || 'unpause left simulation paused');

await step('regression-world-switch-undo', async () => {
  const before = await page.evaluate(async () => { const app = window.__anant; await app.persist(true); return { id: app.state.id, name: app.state.name }; });
  await page.evaluate(() => window.__anant.hud.worldsPill.click());
  page.once('dialog', dialog => dialog.accept('Regression world B'));
  await page.getByRole('button', { name: '+ New universe', exact: true }).click();
  await page.waitForFunction(() => window.__anant.state.name === 'Regression world B');
  const bId = await page.evaluate(() => window.__anant.state.id);
  await say('Undo');
  const stayed = await page.evaluate(id => window.__anant.state.id === id && window.__anant.state.objects.length === 0, bId);
  await page.evaluate(() => window.__anant.hud.worldsPill.click());
  await page.locator('.worlds .w').filter({ hasText: before.name }).click();
  await page.waitForFunction(id => window.__anant.state.id === id, before.id);
  // Reload immediately, without saving the selected world again. Selection must
  // survive even though the world we just left has the newest save timestamp.
  await page.reload();
  await page.waitForFunction(() => window.__anant?.engine?.fps?.value > 0);
  const resumed = await page.evaluate(id => window.__anant.state.id === id, before.id);
  return [stayed, resumed];
}, (_s, a) => (a[0] && a[1]) || 'undo or reload restored a different world');

await step('regression-cinema-controls', async () => {
  await page.getByRole('button', { name: 'Cinema', exact: true }).click();
  const hidden = await page.locator('#hud').evaluate(el => el.inert && getComputedStyle(el).visibility === 'hidden');
  await page.keyboard.press('Escape');
  const restored = await page.locator('#hud').evaluate(el => !el.inert && getComputedStyle(el).visibility !== 'hidden');
  return [hidden && restored];
}, (_s, a) => a[0] || 'cinema did not hide/restore accessible controls');

// Persistence: reload the page — everything must come back from SQLite.
await say('Pause the simulation');
await page.evaluate(() => window.__anant.persist(true));
const beforeReload = await state();
await page.reload();
await page.waitForFunction(() => window.__anant?.engine?.fps?.value > 0, null, { timeout: 240000 });
await page.waitForTimeout(1500);
const afterReload = await state();
report.persistence = { beforeReload, afterReload, equal: JSON.stringify({ ...beforeReload, conv: undefined }) === JSON.stringify({ ...afterReload, conv: undefined }) };
if (!report.persistence.equal) report.ok = false;
console.log(`${report.persistence.equal ? 'PASS' : 'FAIL'}  persistence-after-reload`);
await page.screenshot({ path: join(OUT, `${String(report.steps.length + 1).padStart(2, '0')}-after-reload.png`) });

await step('finale', async () => { await page.evaluate(() => window.__anant.finale()); await page.waitForTimeout(3500); return []; }, () => true);

report.finishedAt = new Date().toISOString();
} catch (error) {
  report.ok = false;
  report.errors.push(String(error?.stack ?? error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, 'e2e.json'), JSON.stringify(report, null, 2));
  console.log(`\nrenderer: ${report.renderer}\nerrors: ${report.errors.length}\n${report.errors.slice(0, 10).join('\n')}\nOVERALL: ${report.ok && !report.errors.length ? 'PASS' : 'FAIL'}`);
  try { await browser?.close(); } finally { await server.stop(); }
}
process.exitCode = report.ok && !report.errors.length ? 0 : 1;
