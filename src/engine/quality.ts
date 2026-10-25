/** Quality tier. `?lowfx` forces the low tier (used by headless CI, which renders on the CPU). */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const low = params.has('lowfx');

export const QUALITY = {
  low,
  maxPixelRatio: low ? 0.75 : 1.5,
  msaa: low ? 0 : 4,
  shadows: !low,
  shadowMap: 2048,
  godRays: !low,
  atomPoints: low ? 40000 : 140000,
  grassBlades: low ? 6000 : 70000,
  blackHoleSteps: low ? 48 : 260,
  reflections: !low,
  adaptive: !low,
};
