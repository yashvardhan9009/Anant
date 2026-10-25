import { describe, it, expect } from 'vitest';
import { createWorld, execute } from '../shared/worldState';
import { parseIntent } from '../shared/localParser';
import { NBody, G_AU } from '../shared/physics';
import { UNIVERSES, derived, universeSystem } from '../shared/universes';
import { routeForSize } from '../shared/scale';
import { REALM_INFO } from '../shared/commands';

describe('universe definitions', () => {
  it('labels every universe but ours as hypothetical', () => {
    expect(UNIVERSES.prime.status).toBe('observed');
    expect(UNIVERSES.prime.G).toBe(1);
    expect(UNIVERSES.heavy.status).toBe('hypothetical');
    expect(REALM_INFO.heavy.mode).toBe('hypothetical');
  });

  it('derives consequences from textbook scalings', () => {
    const d = derived(UNIVERSES.heavy); // G × 4
    expect(d.orbitalSpeed).toBeCloseTo(2, 12);
    expect(d.earthYearDays).toBeCloseTo(365.25 / 2, 9);
    expect(d.luminosity).toBe(256);
    expect(d.sunLifetimeYr).toBeCloseTo(1e10 / 256, 0);
    expect(derived(UNIVERSES.prime).period).toBe(1);
  });

  it('keeps planets on circular orbits when G changes, with shorter periods', () => {
    const g = UNIVERSES.heavy.G;
    const sim = new NBody(universeSystem(UNIVERSES.heavy));
    sim.gScale = g;
    const earth = sim.index('earth');
    const el = sim.orbitalElements(earth);
    expect(el.e).toBeLessThan(0.01);
    expect(el.a).toBeCloseTo(1, 2);
    expect(el.period).toBeCloseTo(1 / Math.sqrt(g), 2);
    // and the energy is conserved by the integrator under the stronger law
    const e0 = sim.energy();
    sim.advance(0.5);
    expect(Math.abs((sim.energy() - e0) / e0)).toBeLessThan(1e-4);
    expect(G_AU * g).toBeCloseTo(4 * 4 * Math.PI * Math.PI, 9);
  });
});

describe('portal into the hypothetical universe', () => {
  it('opens, enters, and keeps a way back', () => {
    let s = execute(createWorld(), { op: 'open_portal', to: 'heavy' }).state;
    const r = execute(s, { op: 'enter_portal' });
    expect(r.result.ok).toBe(true);
    s = r.state;
    expect(s.activeRealm).toBe('heavy');
    expect(s.portals.some((p) => p.from === 'heavy' && p.to === 'nexus')).toBe(true);
  });

  it('is observe-only: bodies cannot be edited there, but gravity and time can', () => {
    const s = execute(createWorld(), { op: 'go_to_realm', realm: 'heavy' }).state;
    const edit = execute(s, { op: 'cosmos_set_body', target: 'jupiter', mass_multiplier: 10 });
    expect(edit.result.ok).toBe(false);
    expect(edit.state).toBe(s);
    expect(execute(s, { op: 'cosmos_grab', target: 'sun' }).result.ok).toBe(false);
    const grav = execute(s, { op: 'set_gravity', multiplier: 2 });
    expect(grav.result.ok).toBe(true);
    expect(grav.state.env.heavy.gravity).toBe(2);
    expect(grav.state.env.cosmos.gravity).toBe(1); // our universe untouched
  });

  it('stays inside the hypothetical universe at astronomical sizes', () => {
    expect(routeForSize(1e12, 'heavy')).toBe('heavy');
    expect(routeForSize(1e12, 'nexus')).toBe('cosmos');
    expect(routeForSize(1e-9, 'heavy')).toBe('atom');
  });
});

describe('parser: multiverse phrases', () => {
  const w = createWorld();
  const ops = (t: string) => parseIntent(t, w).commands;
  it('routes universe requests to the hypothetical realm', () => {
    expect(ops('Open a portal to a universe with stronger gravity')).toEqual([{ op: 'open_portal', to: 'heavy' }]);
    expect(ops('open a portal to another universe')).toEqual([{ op: 'open_portal', to: 'heavy' }]);
    expect(ops('take me to the heavy gravity universe')).toEqual([{ op: 'go_to_realm', realm: 'heavy' }]);
  });
  it('still routes our own universe to the Cosmos', () => {
    expect(ops('take me back to our universe')).toEqual([{ op: 'go_to_realm', realm: 'cosmos' }]);
    expect(ops('open a portal to space')).toEqual([{ op: 'open_portal', to: 'cosmos' }]);
  });
});
