/**
 * Hydrogen atom — exact non-relativistic solutions of the Schrödinger equation.
 *
 *   ψ_nlm(r,θ,φ) = R_nl(r) · Y_lm(θ,φ)
 *
 * Lengths are in Bohr radii (a₀ = 0.529 Å). We use *real* spherical harmonics
 * (p_x, p_y, p_z, d_xy, …), the standard chemistry basis, so the sign of ψ is
 * real-valued and can be shown as colour. Point clouds are Monte-Carlo samples
 * drawn from |ψ|², i.e. each dot is a possible position-measurement outcome.
 * No planetary orbits anywhere.
 */

const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));

/** Generalized Laguerre polynomial L_k^α(x) via the three-term recurrence. */
export function laguerre(k: number, alpha: number, x: number): number {
  if (k === 0) return 1;
  let L0 = 1;
  let L1 = 1 + alpha - x;
  for (let i = 1; i < k; i++) {
    const L2 = ((2 * i + 1 + alpha - x) * L1 - (i + alpha) * L0) / (i + 1);
    L0 = L1;
    L1 = L2;
  }
  return L1;
}

/** Normalized radial function R_nl(r), r in Bohr radii. ∫ R² r² dr = 1. */
export function radial(n: number, l: number, r: number): number {
  const rho = (2 * r) / n;
  const norm = Math.sqrt(Math.pow(2 / n, 3) * (factorial(n - l - 1) / (2 * n * factorial(n + l))));
  return norm * Math.exp(-rho / 2) * Math.pow(rho, l) * laguerre(n - l - 1, 2 * l + 1, rho);
}

/** Associated Legendre P_l^m(x), m ≥ 0 (Condon–Shortley phase omitted; only affects global sign). */
export function legendre(l: number, m: number, x: number): number {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt(Math.max(0, 1 - x * x));
    let f = 1;
    for (let i = 1; i <= m; i++) {
      pmm *= f * s;
      f += 2;
    }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

/** Real spherical harmonic Y_lm(θ, φ). m>0 → cos(mφ), m<0 → sin(|m|φ). */
export function realY(l: number, m: number, theta: number, phi: number): number {
  const am = Math.abs(m);
  const N = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (factorial(l - am) / factorial(l + am)));
  const P = legendre(l, am, Math.cos(theta));
  if (m === 0) return N * P;
  if (m > 0) return Math.SQRT2 * N * P * Math.cos(m * phi);
  return Math.SQRT2 * N * P * Math.sin(am * phi);
}

export function psi(n: number, l: number, m: number, x: number, y: number, z: number): number {
  const r = Math.hypot(x, y, z);
  const theta = r === 0 ? 0 : Math.acos(z / r);
  const phi = Math.atan2(y, x);
  return radial(n, l, r) * realY(l, m, theta, phi);
}

/** Radial probability density P(r) = r² R_nl(r)². */
export const radialProbability = (n: number, l: number, r: number) => r * r * radial(n, l, r) ** 2;

export function maxRadius(n: number): number {
  return 4 * n * n + 8;
}

/** argmax_r P(r): the "most probable" distance from the nucleus (a₀). */
export function mostProbableRadius(n: number, l: number): number {
  const rMax = maxRadius(n);
  let best = 0, bestP = -1;
  for (let i = 1; i <= 20000; i++) {
    const r = (i / 20000) * rMax;
    const p = radialProbability(n, l, r);
    if (p > bestP) {
      bestP = p;
      best = r;
    }
  }
  return best;
}

/** ⟨r⟩ analytic: a₀/2 · (3n² − l(l+1)) */
export const expectedRadius = (n: number, l: number) => 0.5 * (3 * n * n - l * (l + 1));

/** Energy level E_n in eV (Bohr model and Schrödinger agree for hydrogen). */
export const energyEV = (n: number) => -13.605693 / (n * n);

/** Photon wavelength (nm) for n1 → n2 using the hydrogen Rydberg constant (reduced-mass corrected). */
export function transitionWavelengthNm(nFrom: number, nTo: number): number {
  const R_H = 1.09677583e7; // m⁻¹
  const inv = R_H * Math.abs(1 / (nTo * nTo) - 1 / (nFrom * nFrom));
  return inv === 0 ? Infinity : 1e9 / inv;
}

export function describeTransition(from: { n: number; l: number }, to: { n: number; l: number }) {
  const dE = energyEV(to.n) - energyEV(from.n);
  const lambda = transitionWavelengthNm(from.n, to.n);
  const kind = dE < 0 ? 'emission' : dE > 0 ? 'absorption' : 'none';
  const dipoleAllowed = Math.abs(to.l - from.l) === 1;
  let band = 'ultraviolet';
  if (lambda >= 380 && lambda <= 750) band = 'visible';
  else if (lambda > 750) band = 'infrared';
  const series = ({ 1: 'Lyman', 2: 'Balmer', 3: 'Paschen', 4: 'Brackett' } as Record<number, string>)[Math.min(from.n, to.n)] ?? '';
  return { dE, lambda, kind, dipoleAllowed, band, series };
}

/** Approximate visible colour of a wavelength (for drawing the emitted photon). */
export function wavelengthToHex(nm: number): string {
  let r = 0, g = 0, b = 0;
  if (nm < 380) return '#b48cff'; // UV: shown as violet-white (artistic: UV is invisible)
  if (nm > 750) return '#ff5a3c'; // IR: shown as deep red (artistic: IR is invisible)
  if (nm < 440) { r = -(nm - 440) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = -(nm - 510) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = -(nm - 645) / 65; }
  else r = 1;
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Deterministic PRNG so tests and the visual are reproducible. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OrbitalSamples {
  positions: Float32Array; // xyz in a₀
  sign: Float32Array; // +1 / −1 (phase of real ψ)
  density: Float32Array; // |ψ|² normalised to [0,1] over the sample set
  count: number;
}

/**
 * Draw `count` samples from |ψ_nlm|². Exact factorisation:
 *   r ~ r² R_nl²   (inverse-CDF on a fine grid)
 *   (θ,φ) ~ |Y_lm|² sinθ   (rejection sampling on the unit sphere)
 */
export function sampleOrbital(n: number, l: number, m: number, count: number, seed = 1): OrbitalSamples {
  const rand = mulberry32(seed + n * 1000 + l * 100 + (m + 5) * 10);
  const rMax = maxRadius(n);
  const G = 4096;
  const cdf = new Float64Array(G + 1);
  for (let i = 1; i <= G; i++) {
    const r = (i / G) * rMax;
    cdf[i] = cdf[i - 1] + radialProbability(n, l, r);
  }
  for (let i = 0; i <= G; i++) cdf[i] /= cdf[G];

  // Max of |Y|² over the sphere (with margin) for rejection sampling.
  let yMax = 0;
  for (let i = 0; i <= 64; i++) for (let j = 0; j < 128; j++) {
    const v = realY(l, m, (i / 64) * Math.PI, (j / 128) * 2 * Math.PI) ** 2;
    if (v > yMax) yMax = v;
  }
  yMax *= 1.05;

  const positions = new Float32Array(count * 3);
  const sign = new Float32Array(count);
  const density = new Float32Array(count);
  let dMax = 0;
  for (let k = 0; k < count; k++) {
    // radial
    const u = rand();
    let lo = 0, hi = G;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid; else hi = mid;
    }
    const f = (u - cdf[lo]) / Math.max(1e-12, cdf[hi] - cdf[lo]);
    const r = ((lo + f) / G) * rMax;
    // angular
    let theta = 0, phi = 0, y = 0;
    for (let tries = 0; tries < 1000; tries++) {
      const cz = 2 * rand() - 1; // uniform on sphere
      theta = Math.acos(cz);
      phi = 2 * Math.PI * rand();
      y = realY(l, m, theta, phi);
      if (rand() * yMax <= y * y) break;
    }
    const st = Math.sin(theta);
    const x = r * st * Math.cos(phi), yy = r * st * Math.sin(phi), z = r * Math.cos(theta);
    // Store with physics z → scene y (up) for display convenience.
    positions[k * 3] = x;
    positions[k * 3 + 1] = z;
    positions[k * 3 + 2] = yy;
    const R = radial(n, l, r);
    const p = R * y;
    sign[k] = p >= 0 ? 1 : -1;
    density[k] = p * p;
    if (density[k] > dMax) dMax = density[k];
  }
  if (dMax > 0) for (let k = 0; k < count; k++) density[k] = Math.pow(density[k] / dMax, 0.35);
  return { positions, sign, density, count };
}
