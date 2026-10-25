// Builds ANANT's astronomy data from real sources:
//  • 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26; VizieR J/ApJS/199/26)
//    → public/assets/astro/2mrs.bin  (Float32: x, y, z [Mpc], size [kpc], type, Ks)
//  • SIMBAD (CDS) coordinates & object types for the named catalog
//  • ESA/Hubble and ESA/Webb images (CC BY 4.0) with their credit lines
// Run: node scripts/build-astro.mjs   (uses curl; respects HTTPS proxies)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const OUT = 'public/assets/astro';
mkdirSync(join(OUT, 'img'), { recursive: true });
const UA = 'ANANT-astro-builder/1.0 (+https://github.com/yashvardhan9009/Anant)';
const get = (url, binary = false) => execFileSync('curl', ['-sSfL', '--retry', '3', '-m', '120', '-A', UA, url], { maxBuffer: 256 << 20, encoding: binary ? 'buffer' : 'utf8' });
const H0 = 70; // km/s/Mpc
const D2R = Math.PI / 180;

// ———————————————————————— 2MRS galaxy field ————————————————————————
if (!existsSync(join(OUT, '2mrs.bin'))) {
  const txt = gunzipSync(get('https://cdsarc.cds.unistra.fr/ftp/J/ApJS/199/26/table3.dat.gz', true)).toString('latin1');
  const rows = [];
  for (const line of txt.split('\n')) {
    if (line.length < 180) continue;
    const l = +line.slice(37, 46), b = +line.slice(47, 56), cz = +line.slice(173, 178);
    const Kt = +line.slice(78, 84), rext = +line.slice(147, 152), type = line.slice(164, 169).trim();
    if (!Number.isFinite(cz) || cz <= 100) continue; // need a positive Hubble-flow distance
    const d = cz / H0; // Mpc (Hubble's law; peculiar velocities distort nearby structure)
    const thetaRad = (Math.pow(10, rext) / 3600) * D2R; // total-aperture semi-major axis
    const sizeKpc = Math.max(3, 2 * d * 1000 * thetaRad);
    // ZCAT morphology: E/S0 → early, S/Sa..Sd → spiral, I → irregular
    const t = /^-?[5-7]|^E/.test(type) ? 0 : /^-?[1-3]|^S0|^L/.test(type) ? 1 : /^(1[0-1]|9|I)/.test(type) ? 3 : 2;
    const cb = Math.cos(b * D2R);
    rows.push([d * cb * Math.cos(l * D2R), d * Math.sin(b * D2R), d * cb * Math.sin(l * D2R), sizeKpc, t, Kt]);
  }
  const f = new Float32Array(rows.length * 6);
  rows.forEach((r, i) => f.set(r, i * 6));
  writeFileSync(join(OUT, '2mrs.bin'), Buffer.from(f.buffer));
  console.log(`[astro] 2MRS: ${rows.length} galaxies with positive redshift`);
}

// ———————————————————————— named catalog ————————————————————————
// Distances are published estimates (pc for Milky Way objects, Mpc beyond). Images verified by page title.
const OBJECTS = JSON.parse(readFileSync('shared/astroObjects.json', 'utf8'));

// ICRS (RA, Dec) → Galactic (l, b), IAU 1958 definition (J2000 rotation matrix)
function toGalactic(raDeg, decDeg) {
  const ra = raDeg * D2R, dec = decDeg * D2R;
  const x = Math.cos(dec) * Math.cos(ra), y = Math.cos(dec) * Math.sin(ra), z = Math.sin(dec);
  const T = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
  const gx = T[0][0] * x + T[0][1] * y + T[0][2] * z, gy = T[1][0] * x + T[1][1] * y + T[1][2] * z, gz = T[2][0] * x + T[2][1] * y + T[2][2] * z;
  return { l: ((Math.atan2(gy, gx) / D2R) + 360) % 360, b: Math.asin(gz) / D2R };
}
const sexa = (s) => { const p = s.trim().split(/\s+/).map(Number); const sg = s.trim().startsWith('-') ? -1 : 1; return sg * (Math.abs(p[0]) + (p[1] ?? 0) / 60 + (p[2] ?? 0) / 3600); };

const catalog = [];
for (const o of OBJECTS) {
  let ra, dec, otype = '';
  try {
    const t = get(`https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(o.simbad)}&output.format=ASCII`);
    const m = t.match(/Coordinates\(ICRS,ep=J2000,eq=2000\):\s+([0-9 .]+?)\s+([+-][0-9 .]+?)\s+\(/);
    if (m) { const r = m[1].trim().split(/\s+/); ra = (+r[0] + (+r[1] || 0) / 60 + (+r[2] || 0) / 3600) * 15; dec = sexa(m[2]); }
    otype = (t.match(/Object .*?---\s+(\S+)\s+---/) ?? [])[1] ?? '';
  } catch (e) {
    console.warn(`[astro] SIMBAD failed for ${o.simbad}: ${e.message}`);
  }
  if (ra === undefined) { console.warn(`[astro] no coordinates for ${o.name} — skipped`); continue; }
  const { l, b } = toGalactic(ra, dec);
  const images = [];
  for (const ref of o.images ?? []) {
    const [arch, id] = ref.split(':');
    const host = arch === 'webb' ? 'esawebb.org' : 'esahubble.org';
    try {
      const page = get(`https://${host}/images/${id}/`);
      const title = (page.match(/og:title" content="([^"]+)/) ?? page.match(/<title>([^<|]+)/) ?? [])[1]?.trim() ?? id;
      const credit = ((page.match(/<div class="credit">([\s\S]*?)<\/div>/) ?? [])[1] ?? (arch === 'webb' ? 'ESA/Webb, NASA & CSA' : 'ESA/Hubble & NASA')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const file = `img/${id}.jpg`;
      if (!existsSync(join(OUT, file))) writeFileSync(join(OUT, file), get(`https://cdn.${host}/archives/images/screen/${id}.jpg`, true));
      images.push({ file, title, credit, telescope: arch === 'webb' ? 'James Webb Space Telescope' : 'Hubble Space Telescope', page: `https://${host}/images/${id}/`, license: 'CC BY 4.0' });
    } catch (e) {
      console.warn(`[astro] image ${ref} failed: ${e.message}`);
    }
  }
  catalog.push({ ...o, ra: +ra.toFixed(5), dec: +dec.toFixed(5), l: +l.toFixed(4), b: +b.toFixed(4), simbadType: otype, images });
  console.log(`[astro] ${o.name.padEnd(42)} l=${l.toFixed(2)} b=${b.toFixed(2)} ${images.length} image(s)`);
}
writeFileSync(join(OUT, 'catalog.json'), JSON.stringify({
  generated: new Date().toISOString(),
  sources: {
    galaxies: '2MASS Redshift Survey — Huchra et al. 2012, ApJS 199, 26 (VizieR J/ApJS/199/26). Distances from redshift with H0 = 70 km/s/Mpc.',
    coordinates: 'SIMBAD astronomical database, CDS Strasbourg.',
    images: 'ESA/Hubble and ESA/Webb image archives (CC BY 4.0); credit lines as published.',
  },
  objects: catalog,
}, null, 2));
console.log(`[astro] catalog: ${catalog.length} objects`);
