/** A quality choice changes rendering only; simulation fidelity is identical. */
export const QUALITY_NAMES = ['ultra', 'cinematic', 'balanced', 'performance'] as const;
export type QualityName = typeof QUALITY_NAMES[number];
export const QUALITY_KEY = 'anant.quality.v1';

export function qualityName(search: string, saved?: string | null): QualityName {
  const params = new URLSearchParams(search);
  if (params.has('lowfx')) return 'performance';
  const requested = params.get('quality') ?? saved;
  return QUALITY_NAMES.includes(requested as QualityName) ? requested as QualityName : 'cinematic';
}

let saved: string | null = null;
try { saved = globalThis.localStorage?.getItem(QUALITY_KEY); } catch { /* storage may be disabled */ }
const name = qualityName(typeof location === 'undefined' ? '' : location.search, saved);
const low = name === 'performance', ultra = name === 'ultra', cinematic = name === 'cinematic' || ultra;

export const QUALITY = {
  name, low, cinematic, ultra,
  maxPixelRatio: low ? 1 : cinematic ? 2 : 1.5,
  minPixelRatio: low ? 0.65 : cinematic ? 1 : 0.75,
  targetFps: cinematic ? 30 : 45,
  msaa: low ? 0 : 4,
  shadows: !low,
  shadowMap: ultra ? 4096 : 2048,
  godRays: !low,
  ambientOcclusion: cinematic,
  atomPoints: low ? 40000 : 140000,
  orbitalSteps: low ? 28 : cinematic ? 144 : 88,
  grassBlades: low ? 6000 : 70000,
  blackHoleSteps: low ? 48 : cinematic ? 260 : 144,
  reflections: !low,
  portalScale: ultra ? 1 : cinematic ? 0.65 : 0.5,
  adaptive: true,
};
