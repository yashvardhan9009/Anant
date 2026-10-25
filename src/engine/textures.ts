/**
 * Procedural PBR texture library. Every material gets colour + normal + roughness
 * maps generated at load time from layered noise — no downloaded assets, but
 * surfaces read as stone, plaster, timber and tile instead of flat colour.
 */
import * as THREE from 'three';

type RGB = [number, number, number];

function hash(x: number, y: number, s: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number, s: number, period: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const P = (a: number) => ((a % period) + period) % period; // tileable
  const a = hash(P(xi), P(yi), s), b = hash(P(xi + 1), P(yi), s), c = hash(P(xi), P(yi + 1), s), d = hash(P(xi + 1), P(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tileable fbm over [0,1)² */
export function fbm(u: number, v: number, freq: number, oct = 5, seed = 1) {
  let s = 0, a = 0.5, f = freq;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(u * f, v * f, seed + i * 13, f);
    f *= 2;
    a *= 0.5;
  }
  return s;
}

export interface PBRSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }

interface Gen {
  size: number;
  /** returns height [0,1], colour, roughness [0,1] at uv */
  sample: (u: number, v: number) => { h: number; c: RGB; r: number };
  normalStrength: number;
}

function build(g: Gen): PBRSet {
  const N = g.size;
  const H = new Float32Array(N * N);
  const col = new Uint8ClampedArray(N * N * 4);
  const rough = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const { h, c, r } = g.sample(x / N, y / N);
    const i = y * N + x;
    H[i] = h;
    col.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
    const rv = r * 255;
    rough.set([rv, rv, rv, 255], i * 4);
  }
  const nrm = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const at = (xx: number, yy: number) => H[((yy + N) % N) * N + ((xx + N) % N)];
    const dx = (at(x + 1, y) - at(x - 1, y)) * g.normalStrength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * g.normalStrength;
    const l = Math.hypot(dx, dy, 1);
    nrm.set([(-dx / l * 0.5 + 0.5) * 255, (dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255, 255], (y * N + x) * 4);
  }
  const mk = (data: Uint8ClampedArray, srgb: boolean) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), normalMap: mk(nrm, false), roughnessMap: mk(rough, false) };
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h: string): RGB => { const c = new THREE.Color(h); return [c.r, c.g, c.b].map((v) => Math.pow(v, 1 / 2.2)) as RGB; };
const clamp = (x: number) => Math.max(0, Math.min(1, x));

const cache = new Map<string, PBRSet>();
function cached(key: string, f: () => PBRSet) {
  if (!cache.has(key)) cache.set(key, f());
  return cache.get(key)!;
}

/** Irregular stone blocks with mortar. */
export const stoneBricks = () => cached('stone', () => build({
  size: 512, normalStrength: 6,
  sample(u, v) {
    const rows = 8, row = Math.floor(v * rows), off = (row % 2) * 0.5;
    const cols = 4, cu = u * cols + off, ci = Math.floor(cu);
    const fu = cu - ci, fv = v * rows - row;
    const jit = hash(ci, row, 3);
    const edge = Math.min(fu, 1 - fu, (fv) * 0.5, (1 - fv) * 0.5) * (0.9 + jit * 0.2);
    const mortar = 1 - clamp(edge / 0.045);
    const n = fbm(u, v, 8, 5, 2);
    const h = (1 - mortar) * (0.6 + n * 0.4 - Math.pow(Math.abs(fu - 0.5) * 2, 6) * 0.15);
    const base = mix(hex('#6d675f'), hex('#8c857a'), jit);
    const c = mix(mix(base, hex('#4c4741'), n * 0.6), hex('#3a3632'), mortar);
    return { h, c: mix(c, hex('#4e5a3e'), clamp((fbm(u, v, 3, 3, 9) - 0.62) * 4) * 0.5), r: 0.82 + mortar * 0.15 };
  },
}));

/** Lime plaster, slightly dirty. */
export const plaster = () => cached('plaster', () => build({
  size: 256, normalStrength: 2.5,
  sample(u, v) {
    const n = fbm(u, v, 6, 5, 4), d = fbm(u, v, 2, 4, 7);
    return { h: n, c: mix(mix(hex('#d9ccb0'), hex('#b8a888'), n), hex('#7a6a58'), clamp((d - 0.55) * 2.5) * 0.6 + clamp(1 - v * 3) * 0.25), r: 0.9 };
  },
}));

/** Weathered timber with grain. */
export const timber = () => cached('timber', () => build({
  size: 256, normalStrength: 4,
  sample(u, v) {
    const g = fbm(u * 0.15, v, 16, 4, 5);
    const ring = Math.sin((v * 40 + g * 6) * Math.PI) * 0.5 + 0.5;
    const h = 0.5 + ring * 0.25 + fbm(u, v, 24, 3, 8) * 0.25;
    return { h, c: mix(hex('#2a1a10'), hex('#5a3d26'), ring * 0.6 + g * 0.3), r: 0.72 + ring * 0.15 };
  },
}));

/** Overlapping clay / slate roof tiles. */
export const roofTiles = (tint = '#6a3b2c') => cached('roof' + tint, () => build({
  size: 512, normalStrength: 7,
  sample(u, v) {
    const rows = 14, row = Math.floor(v * rows), fv = v * rows - row;
    const cols = 10, off = (row % 2) * 0.5, cu = u * cols + off, ci = Math.floor(cu), fu = cu - ci;
    const j = hash(ci, row, 11);
    const round = Math.sqrt(Math.max(0, 1 - Math.pow((fu - 0.5) * 2, 2)));
    const h = fv * 0.7 + round * 0.3;
    const gap = clamp((Math.min(fu, 1 - fu)) / 0.04);
    const base = mix(hex(tint), hex('#2d2020'), j * 0.5 + fbm(u, v, 10, 3, 3) * 0.3);
    return { h: h * gap, c: mix(hex('#1a1414'), mix(base, hex('#3a4a30'), clamp((fbm(u, v, 4, 3, 12) - 0.6) * 3) * 0.6), gap * (0.55 + fv * 0.45)), r: 0.75 + (1 - gap) * 0.2 };
  },
}));

/** Ground detail: grass/soil micro-variation (multiplied over terrain vertex colours). */
export const groundDetail = () => cached('ground', () => build({
  size: 512, normalStrength: 5,
  sample(u, v) {
    const n = fbm(u, v, 16, 5, 6), p = fbm(u, v, 64, 2, 2);
    const pebbles = clamp((fbm(u, v, 32, 2, 14) - 0.68) * 6);
    return { h: n * 0.6 + p * 0.3 + pebbles * 0.4, c: mix(mix([0.82, 0.82, 0.8], [1.05, 1.05, 1.0], n), [0.75, 0.72, 0.68], pebbles), r: 0.92 - pebbles * 0.2 };
  },
}));

/** Dark polished stone / obsidian with veins. */
export const obsidian = () => cached('obsidian', () => build({
  size: 512, normalStrength: 1.5,
  sample(u, v) {
    const n = fbm(u, v, 3, 6, 21);
    const vein = Math.pow(1 - Math.abs(Math.sin((u * 3 + n * 4) * Math.PI)), 18);
    return { h: n * 0.3, c: mix(mix(hex('#0b0a10'), hex('#17141f'), n), hex('#4a3f6a'), vein * 0.6), r: 0.12 + n * 0.12 + vein * 0.1 };
  },
}));

/** Brushed dark metal with panel seams. */
export const darkMetal = () => cached('metal', () => build({
  size: 256, normalStrength: 3,
  sample(u, v) {
    const brush = fbm(u * 0.05, v, 64, 2, 31);
    const seam = Math.min(Math.abs(v * 4 - Math.round(v * 4)), 1) < 0.012 ? 1 : 0;
    return { h: brush * 0.2 - seam * 0.5, c: mix(hex('#1c1b22'), hex('#2a2833'), brush), r: 0.32 + brush * 0.15 + seam * 0.3 };
  },
}));

/** Rock face for cliffs and boulders. */
export const rock = () => cached('rock', () => build({
  size: 256, normalStrength: 8,
  sample(u, v) {
    const n = fbm(u, v, 5, 6, 41), c2 = fbm(u, v, 20, 3, 43);
    return { h: n * 0.8 + c2 * 0.2, c: mix(mix(hex('#4a4744'), hex('#7a746c'), n), hex('#3d4a33'), clamp((c2 - 0.6) * 3) * 0.5), r: 0.88 };
  },
}));

/** Fabric for clothing. */
export const cloth = () => cached('cloth', () => build({
  size: 128, normalStrength: 3,
  sample(u, v) {
    const weave = (Math.sin(u * Math.PI * 128) * Math.sin(v * Math.PI * 128)) * 0.5 + 0.5;
    const n = fbm(u, v, 6, 3, 51);
    return { h: weave * 0.3 + n * 0.3, c: mix([0.85, 0.85, 0.85], [1, 1, 1], n * 0.6 + weave * 0.2), r: 0.95 };
  },
}));

/** Apply a PBR set to a material with a UV repeat. Textures are cloned so repeats can differ. */
export function applyPBR(m: THREE.MeshStandardMaterial, set: PBRSet, repeat = 1, normalScale = 1) {
  const c = (t: THREE.Texture) => {
    const x = t.clone();
    x.repeat.set(repeat, repeat);
    x.needsUpdate = true;
    return x;
  };
  m.map = repeat === 1 ? set.map : c(set.map);
  m.normalMap = repeat === 1 ? set.normalMap : c(set.normalMap);
  m.roughnessMap = repeat === 1 ? set.roughnessMap : c(set.roughnessMap);
  m.normalScale.set(normalScale, normalScale);
  m.needsUpdate = true;
  return m;
}

/** Soft round sprite (gaussian) for particles. */
export function softSprite(): THREE.Texture {
  return cached('sprite', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    return { map: t, normalMap: t, roughnessMap: t };
  }).map;
}
