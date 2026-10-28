// Reference-driven asset pipeline.
// Downloads CC0 assets from Poly Haven (models, scanned PBR textures, HDRI skies),
// optimises models for real-time use (meshoptimizer simplification, WebP textures,
// meshopt compression) and writes them to public/assets with a credits file.
//
//   node scripts/fetch-assets.mjs            # fetch + optimise everything missing
//   node scripts/fetch-assets.mjs --force    # rebuild all
//
// Uses curl (respects HTTPS proxies, unlike Node's fetch). All assets are CC0.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const UA = 'ANANT-asset-pipeline/1.0 (+https://github.com/yashvardhan9009/Anant; CC0 assets credited)';
const CACHE = process.env.ASSET_CACHE || '.asset-cache';
const OUT = 'public/assets';
const FORCE = process.argv.includes('--force');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const want = (id) => !ONLY || ONLY.includes(id);

/** Models: id → simplification ratio (fraction of triangles kept) and texture size. */
export const MODELS = {
  // trees (film-quality scans → heavily simplified for real time)
  fir_tree_01: { ratio: 0.012, tex: 1024, error: 0.003 },
  pine_tree_01: { ratio: 0.006, tex: 1024, error: 0.003 },
  island_tree_02: { ratio: 0.07, tex: 1024, error: 0.003 },
  tree_small_02: { ratio: 0.05, tex: 1024, error: 0.003 },
  dead_tree_trunk: { ratio: 0.08, tex: 1024, error: 0.04 },
  // ground cover & rocks
  shrub_01: { ratio: 0.05, tex: 1024, error: 0.04 },
  shrub_04: { ratio: 0.4, tex: 1024 },
  fern_02: { ratio: 0.3, tex: 1024 },
  grass_medium_01: { ratio: 0.06, tex: 1024 },
  grass_medium_02: { ratio: 0.2, tex: 1024 },
  nettle_plant: { ratio: 0.1, tex: 1024 },
  rock_moss_set_01: { ratio: 0.1, tex: 1024 },
  boulder_01: { ratio: 0.1, tex: 1024, error: 0.04 },
  tree_stump_01: { ratio: 0.15, tex: 1024, error: 0.04 },
  // props
  wine_barrel_01: { ratio: 1, tex: 1024 },
  wooden_barrels_01: { ratio: 0.5, tex: 1024 },
  wooden_crate_01: { ratio: 1, tex: 1024 },
  wooden_lantern_01: { ratio: 0.6, tex: 1024 },
  Lantern_01: { ratio: 1, tex: 1024 },
  wooden_bucket_01: { ratio: 1, tex: 1024 },
  stone_fire_pit: { ratio: 0.5, tex: 1024 },
  treasure_chest: { ratio: 0.6, tex: 1024 },
  gothic_statue: { ratio: 0.4, tex: 1024 },
  antique_estoc: { ratio: 1, tex: 1024 },
  large_castle_door: { ratio: 0.6, tex: 1024 },
};

/** Scanned PBR surfaces (colour, OpenGL normal, AO/rough/metal packed). */
export const TEXTURES = {
  marble_01: '2k', granite_tile_02: '2k', concrete_floor_02: '2k',
  cobblestone_floor_01: '1k', grassy_cobblestone: '1k', plastered_wall_02: '1k', worn_mossy_plasterwall: '1k',
  weathered_planks: '1k', clay_roof_tiles_02: '1k', roof_slates_02: '1k', thatch_roof_angled: '1k',
  forest_ground_04: '1k', leafy_grass: '1k', stone_wall_04: '1k', castle_brick_01: '1k', mossy_rock: '1k', pine_bark: '1k',
};

/** HDRI skies (equirectangular, used for both background and image-based lighting). */
export const HDRIS = { kloppenheim_06_puresky: '4k', kloppenheim_02_puresky: '2k', moonless_golf: '2k', kloofendal_48d_partly_cloudy_puresky: '4k' };

function curl(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync('curl', ['-sSfL', '--retry', '3', '-A', UA, '-o', dest, url], { stdio: 'inherit' });
}
function api(path) {
  return JSON.parse(execFileSync('curl', ['-sSfL', '--retry', '3', '-A', UA, `https://api.polyhaven.com/${path}`], { maxBuffer: 64 << 20 }).toString());
}
const credits = existsSync(join(OUT, 'CREDITS.json')) ? JSON.parse(readFileSync(join(OUT, 'CREDITS.json'), 'utf8')) : {};
function credit(id, type) {
  if (credits[id]) return;
  const info = api(`info/${id}`);
  credits[id] = { name: info.name, type, authors: Object.keys(info.authors ?? {}), license: 'CC0 1.0', source: `https://polyhaven.com/a/${id}` };
}
const mb = (p) => (statSync(p).size / 1e6).toFixed(2);

for (const [id, opt] of Object.entries(MODELS)) {
  const out = join(OUT, 'models', `${id}.glb`);
  if (!want(id) || (existsSync(out) && !FORCE)) continue;
  try {
    const g = api(`files/${id}`).gltf['1k'].gltf;
    const dir = join(CACHE, 'models', id);
    const main = join(dir, g.url.split('/').pop());
    if (!existsSync(main)) {
      curl(g.url, main);
      for (const [rel, f] of Object.entries(g.include ?? {})) curl(f.url, join(dir, rel));
    }
    mkdirSync(dirname(out), { recursive: true });
    const args = ['node_modules/@gltf-transform/cli/bin/cli.js', 'optimize', main, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', String(opt.tex), '--simplify', opt.ratio < 1 ? 'true' : 'false'];
    if (opt.ratio < 1) args.push('--simplify-ratio', String(opt.ratio), '--simplify-error', String(opt.error ?? 0.01));
    execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    credit(id, 'model');
    console.log(`[assets] model  ${id.padEnd(22)} → ${mb(out)} MB`);
  } catch (e) {
    console.warn(`[assets] model ${id} failed: ${e.message} (engine will use its procedural fallback)`);
  }
}

for (const [id, res] of Object.entries(TEXTURES)) {
  const dir = join(OUT, 'textures', id);
  if (!want(id) || (existsSync(join(dir, 'diff.jpg')) && !FORCE)) continue;
  try {
    const f = api(`files/${id}`);
    curl(f.Diffuse[res].jpg.url, join(dir, 'diff.jpg'));
    curl(f.nor_gl[res].jpg.url, join(dir, 'nor.jpg'));
    curl((f.arm ?? f.Rough)[res].jpg.url, join(dir, 'arm.jpg'));
    credit(id, 'texture');
    console.log(`[assets] texture ${id}`);
  } catch (e) {
    console.warn(`[assets] texture ${id} failed: ${e.message}`);
  }
}

for (const [id, res] of Object.entries(HDRIS)) {
  const out = join(OUT, 'hdri', `${id}.hdr`);
  if (!want(id) || (existsSync(out) && !FORCE)) continue;
  try {
    curl(api(`files/${id}`).hdri[res].hdr.url, out);
    credit(id, 'hdri');
    console.log(`[assets] hdri   ${id} (${mb(out)} MB)`);
  } catch (e) {
    console.warn(`[assets] hdri ${id} failed: ${e.message}`);
  }
}

// ——— Science realms: planetary maps & Milky Way (Solar System Scope, CC BY 4.0, from NASA data) ———
const SSS = 'https://www.solarsystemscope.com/textures/download/';
export const SPACE = [
  '8k_stars_milky_way.jpg', '2k_sun.jpg', '2k_mercury.jpg', '2k_venus_atmosphere.jpg', '8k_earth_daymap.jpg', '2k_earth_nightmap.jpg',
  '2k_earth_clouds.jpg', '2k_moon.jpg', '2k_mars.jpg', '2k_jupiter.jpg', '2k_saturn.jpg', '2k_saturn_ring_alpha.png', '2k_uranus.jpg', '2k_neptune.jpg',
];
for (const f of SPACE) {
  const out = join(OUT, 'space', f);
  if (!want(f) || (existsSync(out) && !FORCE)) continue;
  try {
    curl(SSS + f, out);
    console.log(`[assets] space  ${f} (${mb(out)} MB)`);
  } catch (e) {
    console.warn(`[assets] space ${f} failed: ${e.message}`);
  }
}
credits.solar_system_scope = { name: 'Planet textures & Milky Way panorama', type: 'texture', authors: ['Solar System Scope / INOVE'], license: 'CC BY 4.0', source: 'https://www.solarsystemscope.com/textures/', note: 'Based on NASA imagery and elevation data.' };

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'CREDITS.json'), JSON.stringify(credits, null, 2));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ models: Object.keys(MODELS).filter((m) => existsSync(join(OUT, 'models', `${m}.glb`))), textures: Object.keys(TEXTURES).filter((t) => existsSync(join(OUT, 'textures', t, 'diff.jpg'))), hdris: Object.keys(HDRIS).filter((h) => existsSync(join(OUT, 'hdri', `${h}.hdr`))), space: SPACE.filter((f) => existsSync(join(OUT, 'space', f))) }, null, 2));
console.log('[assets] done — credits in public/assets/CREDITS.json');
