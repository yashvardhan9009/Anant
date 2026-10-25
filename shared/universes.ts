/**
 * Universe definitions — the foundation of ANANT's multiverse.
 *
 * A universe is a named set of physical constants plus an honesty label. "prime" is
 * ours (observed). Every other universe is HYPOTHETICAL: the engine still computes
 * its consequences with real equations, but the premise is not something we observe.
 *
 * Derived quantities use textbook scalings so they can be checked by hand:
 *  - circular orbital speed v = √(GM/r)  → v ∝ G^½, period ∝ G^−½
 *  - main-sequence luminosity from stellar homology with electron-scattering
 *    opacity, L ∝ G⁴M³ (an order-of-magnitude scaling, not a stellar-evolution model)
 *  - lifetime t ∝ M/L ∝ G⁻⁴ at fixed mass
 */
import { makePreset, type BodyDef } from './physics.js';

export type UniverseStatus = 'observed' | 'hypothetical';

export interface UniverseDef {
  id: string;
  name: string;
  status: UniverseStatus;
  /** gravitational constant as a multiple of ours */
  G: number;
  premise: string;
  /** colour of the light that sun-like stars appear in (artistic hint for the renderer) */
  starTint: string;
}

export const UNIVERSES = {
  prime: {
    id: 'prime',
    name: 'Our Universe',
    status: 'observed',
    G: 1,
    premise: 'The universe we observe. G = 6.674×10⁻¹¹ m³ kg⁻¹ s⁻².',
    starTint: '#ffcf6b',
  },
  heavy: {
    id: 'heavy',
    name: 'Heavy-Gravity Universe',
    status: 'hypothetical',
    G: 4,
    premise: 'What if gravity were four times stronger? Same masses, same orbits — only G changes.',
    starTint: '#cfe0ff',
  },
} as const satisfies Record<string, UniverseDef>;

export type UniverseId = keyof typeof UNIVERSES;

const SUN_LIFETIME_YR = 1e10;

/** Consequences of changing G, relative to our universe (all at fixed masses and orbit sizes). */
export function derived(u: Pick<UniverseDef, 'G'>) {
  const g = u.G;
  return {
    orbitalSpeed: Math.sqrt(g),
    period: 1 / Math.sqrt(g),
    earthYearDays: 365.25 / Math.sqrt(g),
    luminosity: g ** 4,
    lifetime: g ** -4,
    sunLifetimeYr: SUN_LIFETIME_YR * g ** -4,
  };
}

/**
 * The solar system rebuilt under a universe's G: same masses and radii, velocities scaled
 * by √G so every planet is still on a circular orbit (otherwise stronger gravity would
 * simply drag them inward — a different, less interesting experiment).
 */
export function universeSystem(u: Pick<UniverseDef, 'G'>): BodyDef[] {
  const k = Math.sqrt(u.G);
  return makePreset('solar_system').map((b) => ({ ...b, vel: [b.vel[0] * k, b.vel[1] * k, b.vel[2] * k] as [number, number, number] }));
}

/** "40 million years", "10 billion years" */
export function formatYears(y: number): string {
  if (y >= 1e9) return `${+(y / 1e9).toPrecision(2)} billion years`;
  if (y >= 1e6) return `${+(y / 1e6).toPrecision(2)} million years`;
  if (y >= 1e3) return `${+(y / 1e3).toPrecision(2)} thousand years`;
  return `${+y.toPrecision(2)} years`;
}
