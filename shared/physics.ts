/**
 * N-body gravitational simulation.
 *
 * Units: astronomical units (AU), years, solar masses. In these units G = 4π²,
 * so Earth on a 1 AU circular orbit has a period of ~1 year.
 * Integrator: velocity Verlet (symplectic, 2nd order) with fixed sub-steps — good
 * long-term energy behaviour for orbital problems.
 *
 * Accuracy notes (surfaced in the UI):
 *  - Planet masses and semi-major axes are real (NASA fact-sheet values).
 *  - Initial orbits are circular and coplanar (real orbits are slightly eccentric/inclined).
 *  - Display positions are radially compressed and body sizes exaggerated for visibility.
 */
export const G_AU = 4 * Math.PI * Math.PI;

export interface BodyDef {
  id: string;
  name: string;
  /** solar masses */
  mass: number;
  /** AU */
  pos: [number, number, number];
  /** AU / year */
  vel: [number, number, number];
  color: string;
  kind: 'star' | 'planet' | 'moon';
  /** display radius (scene units, artistic) */
  radius: number;
}

/** Real planetary data: [name, mass (M☉), semi-major axis (AU), color, display radius] */
export const SOLAR_DATA: [string, number, number, string, number][] = [
  ['Mercury', 1.652e-7, 0.387, '#a9a29b', 0.18],
  ['Venus', 2.447e-6, 0.723, '#e8c27a', 0.32],
  ['Earth', 3.003e-6, 1.0, '#4f8dff', 0.34],
  ['Mars', 3.227e-7, 1.524, '#d0623b', 0.24],
  ['Jupiter', 9.545e-4, 5.203, '#d9b38c', 0.9],
  ['Saturn', 2.858e-4, 9.537, '#e6d39a', 0.78],
  ['Uranus', 4.366e-5, 19.19, '#9fe3ea', 0.55],
  ['Neptune', 5.151e-5, 30.07, '#4466ff', 0.54],
];

function circularBody(name: string, mass: number, a: number, color: string, radius: number, phase: number, centralMass: number): BodyDef {
  const v = Math.sqrt((G_AU * centralMass) / a);
  return {
    id: name.toLowerCase().replace(/\s+/g, '_'),
    name,
    mass,
    pos: [a * Math.cos(phase), 0, a * Math.sin(phase)],
    vel: [-v * Math.sin(phase), 0, v * Math.cos(phase)],
    color,
    kind: 'planet',
    radius,
  };
}

/** Golden-angle phases: deterministic, visually spread out. */
const phaseOf = (i: number) => (i * 2.399963) % (2 * Math.PI);

export function makePreset(preset: 'solar_system' | 'inner_planets' | 'binary_star' | 'empty'): BodyDef[] {
  const sun: BodyDef = { id: 'sun', name: 'Sun', mass: 1, pos: [0, 0, 0], vel: [0, 0, 0], color: '#ffcf6b', kind: 'star', radius: 1.6 };
  let bodies: BodyDef[];
  switch (preset) {
    case 'solar_system':
      bodies = [sun, ...SOLAR_DATA.map(([n, m, a, c, r], i) => circularBody(n, m, a, c, r, phaseOf(i), 1))];
      break;
    case 'inner_planets':
      bodies = [sun, ...SOLAR_DATA.slice(0, 5).map(([n, m, a, c, r], i) => circularBody(n, m, a, c, r, phaseOf(i), 1))];
      break;
    case 'binary_star': {
      // Two 0.6 M☉ stars separated by 1 AU on a circular mutual orbit, plus a circumbinary planet.
      const m = 0.6, d = 1.0;
      const v = Math.sqrt((G_AU * m) / (2 * d)); // each star's speed around the barycentre
      bodies = [
        { id: 'star_a', name: 'Star A', mass: m, pos: [d / 2, 0, 0], vel: [0, 0, v], color: '#ffb36b', kind: 'star', radius: 1.1 },
        { id: 'star_b', name: 'Star B', mass: m, pos: [-d / 2, 0, 0], vel: [0, 0, -v], color: '#8fb8ff', kind: 'star', radius: 1.0 },
        circularBody('Tatooine', 3e-6, 3.2, '#d9a066', 0.36, 0.6, 2 * m),
      ];
      break;
    }
    case 'empty':
      bodies = [sun];
      break;
  }
  return zeroMomentum(bodies);
}

/** Shift velocities so total momentum is zero (keeps the system centred). */
export function zeroMomentum(bodies: BodyDef[]): BodyDef[] {
  let M = 0;
  const p = [0, 0, 0];
  for (const b of bodies) {
    M += b.mass;
    for (let k = 0; k < 3; k++) p[k] += b.mass * b.vel[k];
  }
  if (M === 0) return bodies;
  return bodies.map((b) => ({ ...b, vel: [b.vel[0] - p[0] / M, b.vel[1] - p[1] / M, b.vel[2] - p[2] / M] as [number, number, number] }));
}

export class NBody {
  n = 0;
  mass: Float64Array = new Float64Array(0);
  pos: Float64Array = new Float64Array(0);
  vel: Float64Array = new Float64Array(0);
  acc: Float64Array = new Float64Array(0);
  ids: string[] = [];
  /** multiplies G (the "make gravity weaker" command) */
  gScale = 1;
  /** Plummer softening (AU) — prevents singular forces in close encounters. */
  softening = 1e-3;
  time = 0;

  constructor(bodies: BodyDef[] = []) {
    this.load(bodies);
  }

  load(bodies: BodyDef[]) {
    this.n = bodies.length;
    this.ids = bodies.map((b) => b.id);
    this.mass = new Float64Array(bodies.map((b) => b.mass));
    this.pos = new Float64Array(bodies.flatMap((b) => b.pos));
    this.vel = new Float64Array(bodies.flatMap((b) => b.vel));
    this.acc = new Float64Array(this.n * 3);
    this.computeAcc();
  }

  index(id: string) {
    return this.ids.indexOf(id);
  }

  computeAcc() {
    const { n, pos, mass, acc } = this;
    const G = G_AU * this.gScale;
    const eps2 = this.softening * this.softening;
    acc.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const fi = G * mass[j] * inv;
        const fj = G * mass[i] * inv;
        acc[i * 3] += fi * dx; acc[i * 3 + 1] += fi * dy; acc[i * 3 + 2] += fi * dz;
        acc[j * 3] -= fj * dx; acc[j * 3 + 1] -= fj * dy; acc[j * 3 + 2] -= fj * dz;
      }
    }
  }

  /** One velocity-Verlet step of dt years. */
  step(dt: number) {
    const { n, pos, vel, acc } = this;
    for (let i = 0; i < n * 3; i++) {
      vel[i] += 0.5 * dt * acc[i];
      pos[i] += dt * vel[i];
    }
    this.computeAcc();
    for (let i = 0; i < n * 3; i++) vel[i] += 0.5 * dt * acc[i];
    this.time += dt;
  }

  /** Advance by `years` using sub-steps no larger than maxDt. Returns steps taken. */
  advance(years: number, maxDt = 0.0005, maxSteps = 600): number {
    if (years <= 0) return 0;
    const steps = Math.min(maxSteps, Math.max(1, Math.ceil(years / maxDt)));
    const dt = years / steps;
    for (let s = 0; s < steps; s++) this.step(dt);
    return steps;
  }

  energy(): number {
    const { n, pos, vel, mass } = this;
    const G = G_AU * this.gScale;
    let ke = 0, pe = 0;
    for (let i = 0; i < n; i++) {
      const v2 = vel[i * 3] ** 2 + vel[i * 3 + 1] ** 2 + vel[i * 3 + 2] ** 2;
      ke += 0.5 * mass[i] * v2;
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        pe -= (G * mass[i] * mass[j]) / Math.sqrt(dx * dx + dy * dy + dz * dz + this.softening ** 2);
      }
    }
    return ke + pe;
  }

  getPos(i: number): [number, number, number] {
    return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
  }
  getVel(i: number): [number, number, number] {
    return [this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]];
  }

  /** Osculating orbital elements of body i relative to body c (default: most massive). */
  orbitalElements(i: number, c = this.mostMassive()): { a: number; e: number; period: number } {
    const G = G_AU * this.gScale;
    const mu = G * (this.mass[i] + this.mass[c]);
    const r = [0, 1, 2].map((k) => this.pos[i * 3 + k] - this.pos[c * 3 + k]);
    const v = [0, 1, 2].map((k) => this.vel[i * 3 + k] - this.vel[c * 3 + k]);
    const rm = Math.hypot(r[0], r[1], r[2]);
    const v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
    const a = 1 / (2 / rm - v2 / mu);
    const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
    const h2 = h[0] ** 2 + h[1] ** 2 + h[2] ** 2;
    const e = Math.sqrt(Math.max(0, 1 - h2 / (mu * a)));
    const period = a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
    return { a, e, period };
  }

  mostMassive(): number {
    let best = 0;
    for (let i = 1; i < this.n; i++) if (this.mass[i] > this.mass[best]) best = i;
    return best;
  }

  snapshot(defs: BodyDef[]): BodyDef[] {
    return defs.map((d) => {
      const i = this.index(d.id);
      return i < 0 ? d : { ...d, mass: this.mass[i], pos: this.getPos(i), vel: this.getVel(i) };
    });
  }
}

/** Radial compression used only for display: keeps 0.4–30 AU on screen together. */
export function displayRadius(au: number): number {
  return 6 * Math.sqrt(au) + au * 0.6;
}

/** Inverse of displayRadius (solve 0.6u² + 6u − D = 0 for u = √r). */
export function inverseDisplayRadius(d: number): number {
  if (d <= 0) return 0;
  const u = (-6 + Math.sqrt(36 + 2.4 * d)) / 1.2;
  return u * u;
}

/** Compress a vector (AU → display units) radially. */
export function compress(v: [number, number, number]): [number, number, number] {
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r < 1e-12) return [0, 0, 0];
  const k = displayRadius(r) / r;
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** Inverse of compress (display units → AU). */
export function decompress(v: [number, number, number]): [number, number, number] {
  const d = Math.hypot(v[0], v[1], v[2]);
  if (d < 1e-12) return [0, 0, 0];
  const k = inverseDisplayRadius(d) / d;
  return [v[0] * k, v[1] * k, v[2] * k];
}
