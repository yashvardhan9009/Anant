// Live-provider smoke test: npm run build && node scripts/e2e-earth.mjs
// External map services are required. CI uses deterministic unit tests instead.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startTestServer } from './test-server.mjs';
const out = process.env.EARTH_QA_OUT || 'test-results/earth';
mkdirSync(out, { recursive: true });
const server = await startTestServer(out);
const browser = await chromium.launch({ args: process.platform === 'win32' ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : [] });
const report = { errors: [], imagery: 0, aerial: 0, terrain: 0, checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('response', r => { if (!r.ok()) return;
    if (r.url().includes('/api/earth/imagery/')) report.imagery++;
    if (r.url().includes('imagery.nationalmap.gov')) report.aerial++;
    if (r.url().includes('elevation-tiles-prod')) report.terrain++;
  });
  await page.goto(`${server.url}/?skipIntro&quality=cinematic`);
  await page.waitForFunction(() => window.__anant?.engine.fps.value > 0);
  const before = await page.evaluate(() => JSON.stringify(window.__anant.state));
  await page.getByRole('button', { name: 'Explore Earth', exact: true }).click();
  await page.waitForFunction(() => window.__anant.earth?.viewer?.scene);
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${out}/earth-globe.png` });
  for (const name of ['Himalayas', 'Grand Canyon', 'New York']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(20000);
    await page.waitForFunction(() => window.__anant.earth.viewer.scene.globe.tilesLoaded, null, { timeout: 60000 }).catch(() => {});
    if (name === 'Himalayas') {
      const height = await page.evaluate(() => {
        const v = window.__anant.earth.viewer, point = v.camera.positionCartographic.clone();
        point.longitude = 86.925 * Math.PI / 180; point.latitude = 27.988 * Math.PI / 180; point.height = 0;
        return v.scene.globe.getHeight(point);
      });
      report.checks.push({ name: 'Everest has measured elevation', pass: height > 6000, height });
    }
    await page.screenshot({ path: `${out}/${name.toLowerCase().replaceAll(' ', '-')}.png` });
  }
  await page.getByRole('textbox', { name: 'Search cities or coordinates' }).fill('Mumbai');
  await page.getByRole('button', { name: 'Fly', exact: true }).click();
  await page.getByRole('button', { name: 'Mumbai, IN', exact: true }).click();
  await page.waitForTimeout(10000);
  report.checks.push({ name: 'City search', pass: await page.locator('.earth-location').textContent() === 'Mumbai, IN' });
  await page.getByRole('button', { name: 'Orbit', exact: true }).click();
  await page.waitForTimeout(1000);
  report.checks.push({ name: 'Orbit toggles', pass: await page.getByRole('button', { name: 'Orbit', exact: true }).getAttribute('aria-pressed') === 'true' });
  await page.getByRole('dialog', { name: 'Earth explorer' }).getByRole('button', { name: 'Cinema', exact: true }).click();
  report.checks.push({ name: 'Cinema retains attribution', pass: await page.locator('.cesium-widget-credits').isVisible() });
  await page.getByRole('button', { name: 'Show controls', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000); await page.screenshot({ path: `${out}/earth-mobile.png` });
  await page.keyboard.press('Escape');
  report.checks.push({ name: 'Restores unchanged world', pass: await page.evaluate(s => JSON.stringify(window.__anant.state) === s, before) });
  report.checks.push({ name: 'Resumes renderer', pass: await page.evaluate(() => !window.__anant.engine.suspended) });
  await page.evaluate(() => window.__anant.openEarth());
  await page.keyboard.press('Escape');
  report.checks.push({ name: 'Reopens and disposes', pass: await page.locator('.earth-explorer').count() === 0 });
  report.checks.push({ name: 'Live satellite, aerial and terrain responses', pass: report.imagery > 10 && report.aerial > 10 && report.terrain > 10 });
  if (report.errors.length || report.checks.some(c => !c.pass)) process.exitCode = 1;
} finally {
  writeFileSync(`${out}/earth-qa.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close(); await server.stop();
}
