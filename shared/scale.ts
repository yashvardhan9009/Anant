/**
 * Universal scale: the observer's APPARENT size, in metres.
 *
 * Apparent size is deliberately separate from mass, simulation time and
 * gravity — growing to the size of the Sun changes what you see, how far you
 * reach and how fast you move, never the physics of the simulation.
 */
import type { RealmId } from './commands.js';

export const MIN_SIZE = 1e-15;
export const MAX_SIZE = 1e26;
export const HUMAN = 1.7;

/** Named sizes (metres) with what you are now comparable to. */
export const SCALE_PRESETS = {
  proton: [1.7e-15, 'the size of a proton'],
  atom: [1e-10, 'the size of a hydrogen atom'],
  molecule: [3e-10, 'the size of a water molecule'],
  atoms: [2e-9, 'small enough to swim among individual molecules'],
  virus: [1e-7, 'the size of a virus'],
  cell: [1e-5, 'the size of a cell'],
  human: [HUMAN, 'human size'],
  building: [100, 'as tall as a building'],
  mountain: [9e3, 'as tall as Everest'],
  earth: [1.27e7, 'as large as Earth'],
  jupiter: [1.43e8, 'as large as Jupiter'],
  sun: [4e9, 'larger than the Sun'],
  hold_sun: [1.4e10, 'large enough to hold the Sun in your hands'],
  solar_system: [1.2e13, 'large enough to hold the solar system'],
  milky_way: [3e21, 'large enough to see the whole Milky Way'],
  galaxies: [8e24, 'large enough to see tens of thousands of galaxies'],
} as const satisfies Record<string, readonly [number, string]>;
export type ScalePreset = keyof typeof SCALE_PRESETS;
export const SCALE_PRESET_IDS = Object.keys(SCALE_PRESETS) as ScalePreset[];

export const clampSize = (m: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, m));

/** Which realm can represent an observer of this size. null = any human-scale realm. */
export function realmForSize(m: number): RealmId | null {
  if (m < 1e-6) return 'atom';
  if (m > 2e3) return 'cosmos';
  return null;
}

/** Where to go when a size requires leaving the current realm. */
export function routeForSize(m: number, current: RealmId): RealmId {
  const r = realmForSize(m);
  if (r) return r;
  return current === 'atom' || current === 'cosmos' ? 'nexus' : current;
}

/** Atom-realm zoom that corresponds to an observer size (zoom 1 = one hydrogen atom). */
export const atomZoomForSize = (m: number) => Math.min(300000, Math.max(0.0005, 1e-10 / m));
export const sizeForAtomZoom = (z: number) => 1e-10 / z;

/** Cosmic representation appropriate to a size. */
export function cosmicLayer(m: number): 'solar' | 'galactic' | 'cosmic' {
  if (m < 2e15) return 'solar';
  if (m < 2e22) return 'galactic';
  return 'cosmic';
}

export function formatLength(m: number): string {
  const ly = 9.4607e15, au = 1.496e11;
  if (m >= 3.086e22) return `${(m / 3.086e22).toPrecision(3)} Mpc`;
  if (m >= 0.1 * ly) return `${(m / ly).toPrecision(3)} light-years`;
  if (m >= 0.01 * au) return `${(m / au).toPrecision(3)} AU`;
  if (m >= 1e3) return `${(m / 1e3).toPrecision(3)} km`;
  if (m >= 1) return `${m.toPrecision(3)} m`;
  if (m >= 1e-3) return `${(m * 1e3).toPrecision(3)} mm`;
  if (m >= 1e-6) return `${(m * 1e6).toPrecision(3)} µm`;
  if (m >= 1e-9) return `${(m * 1e9).toPrecision(3)} nm`;
  if (m >= 1e-12) return `${(m * 1e12).toPrecision(3)} pm`;
  return `${(m * 1e15).toPrecision(3)} fm`;
}

/** A sentence describing the observer's size relative to familiar things. */
export function describeSize(m: number): string {
  let best: ScalePreset = 'human';
  let bestD = Infinity;
  for (const id of SCALE_PRESET_IDS) {
    const d = Math.abs(Math.log10(SCALE_PRESETS[id][0] / m));
    if (d < bestD) { bestD = d; best = id; }
  }
  const near = bestD < 0.35 ? `about ${SCALE_PRESETS[best][1]}` : `${m > SCALE_PRESETS[best][0] ? 'larger' : 'smaller'} than ${SCALE_PRESETS[best][1].replace(/^(the size of |as (large|tall) as |large enough to |small enough to )/, '')}`;
  return `${formatLength(m)} — ${near}`;
}

/**
 * Cosmos realm: apparent height in DISPLAY units. The cosmos display compresses
 * distances and exaggerates planets, so the observer is mapped onto the same
 * display scale through anchors (log-log interpolation): a human is a speck,
 * Earth-sized is Earth's drawn size, "hold the Sun" makes the Sun hand-sized.
 */
const COSMOS_ANCHORS: [number, number][] = [
  [1.7, 0.0025], [1e5, 0.02], [1.27e7, 0.68], [1.43e8, 1.8], [1.39e9, 3.2], [1.4e10, 9], [1.2e13, 130], [2e15, 600],
];
export function cosmosDisplayHeight(m: number): number {
  const a = COSMOS_ANCHORS;
  if (m <= a[0][0]) return a[0][1] * (m / a[0][0]);
  for (let i = 1; i < a.length; i++) {
    if (m <= a[i][0]) {
      const t = (Math.log(m) - Math.log(a[i - 1][0])) / (Math.log(a[i][0]) - Math.log(a[i - 1][0]));
      return Math.exp(Math.log(a[i - 1][1]) + t * (Math.log(a[i][1]) - Math.log(a[i - 1][1])));
    }
  }
  return a[a.length - 1][1] * (m / a[a.length - 1][0]);
}
