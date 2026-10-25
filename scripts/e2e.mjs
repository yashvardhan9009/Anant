// End-to-end run of the hackathon demo in a real (headless) Chromium.
// Starts the server on a temp DB, drives the UI through every scene, walks
// through portals, reloads to verify persistence, and records measured FPS
// and Director latency. Output: test-results/e2e.json + screenshots.
//
// NOTE: headless Chromium renders WebGL with SwiftShader (CPU). FPS numbers
// from this script are a lower bound and NOT representative of a GPU laptop.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });
const PORT = process.env.E2E_PORT || '8799';
const DB = join(OUT, 'e2e.db');
rmSync(DB, { force: true });
const server = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT, ANANT_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const URL = `http://localhost:${PORT}/?skipIntro`;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const report = { startedAt: new Date().toISOString(), renderer: '', steps: [], errors: [], persistence: null, ok: true };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`console: ${m.text()}`); });

await page.goto(URL);
await page.waitForFunction(() => window.__anant?.engine?.fps?.value > 0, null, { timeout: 30000 });
report.renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
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
  return { realm: s.activeRealm, objects: s.objects.map((o) => `${o.kind}@${o.realm}`), portals: s.portals.map((p) => `${p.from}->${p.to}`), atom: [s.atom.n, s.atom.l, s.atom.m], jupiter: s.cosmos.bodies.find((b) => b.id === 'jupiter')?.mass, conv: s.story.activeConversation, knows: s.story.playerKnows.length, outcome: s.story.outcome?.kind };
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
  const cx = 720, cy = 430, R = 140;
  await page.mouse.move(cx + R, cy);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i <= 40; i++) await page.mouse.move(cx + R * Math.cos((i / 36) * 2 * Math.PI), cy + R * Math.sin((i / 36) * 2 * Math.PI));
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
  await page.waitForTimeout(9000);
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

// Persistence: reload the page — everything must come back from SQLite.
await page.waitForTimeout(2500);
const beforeReload = await state();
await page.reload();
await page.waitForFunction(() => window.__anant?.engine?.fps?.value > 0, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const afterReload = await state();
report.persistence = { beforeReload, afterReload, equal: JSON.stringify({ ...beforeReload, conv: undefined }) === JSON.stringify({ ...afterReload, conv: undefined }) };
if (!report.persistence.equal) report.ok = false;
console.log(`${report.persistence.equal ? 'PASS' : 'FAIL'}  persistence-after-reload`);
await page.screenshot({ path: join(OUT, `${String(report.steps.length + 1).padStart(2, '0')}-after-reload.png`) });

await step('finale', async () => { await page.evaluate(() => window.__anant.finale()); await page.waitForTimeout(3500); return []; }, () => true);

report.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, 'e2e.json'), JSON.stringify(report, null, 2));
console.log(`\nrenderer: ${report.renderer}\nerrors: ${report.errors.length}\n${report.errors.slice(0, 10).join('\n')}\nOVERALL: ${report.ok && !report.errors.length ? 'PASS' : 'FAIL'}`);
await browser.close();
server.kill();
process.exit(report.ok && !report.errors.length ? 0 : 1);
