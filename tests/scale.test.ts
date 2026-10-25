import { describe, it, expect } from 'vitest';
import { createWorld, execute } from '../shared/worldState';
import { parseIntent } from '../shared/localParser';
import { cosmosDisplayHeight, routeForSize, describeSize, atomZoomForSize, sizeForAtomZoom, cosmicLayer } from '../shared/scale';
import { validateCommands } from '../shared/commands';

describe('universal scale', () => {
  it('shrinking below a micron routes to the micro-world and sets the atom zoom', () => {
    const r = execute(createWorld(), { op: 'set_scale', preset: 'molecule' });
    expect(r.result.ok).toBe(true);
    expect(r.state.activeRealm).toBe('atom');
    expect(r.state.observer.size).toBeCloseTo(3e-10);
    expect(r.state.atom.scale).toBeCloseTo(1 / 3, 5);
    expect(r.result.message).toMatch(/mass is unchanged/);
  });
  it('growing beyond 2 km routes to the cosmos; returning to human size leaves it', () => {
    let r = execute(createWorld(), { op: 'set_scale', preset: 'hold_sun' });
    expect(r.state.activeRealm).toBe('cosmos');
    r = execute(r.state, { op: 'set_scale', preset: 'human' });
    expect(r.state.activeRealm).toBe('nexus');
    expect(r.state.observer.size).toBe(1.7);
  });
  it('scale does not touch gravity, masses or time', () => {
    const s0 = createWorld();
    const r = execute(s0, { op: 'set_scale', preset: 'sun' });
    expect(r.state.cosmos.bodies).toEqual(s0.cosmos.bodies);
    expect(r.state.env.cosmos.gravity).toBe(1);
    expect(r.state.time).toEqual(s0.time);
  });
  it('factors compound and clamp', () => {
    let s = createWorld();
    for (let i = 0; i < 40; i++) s = execute(s, { op: 'set_scale', factor: 0.01 }).state;
    expect(s.observer.size).toBe(1e-15);
  });
  it('atom zoom and observer size stay in sync', () => {
    let s = execute(createWorld(), { op: 'set_scale', preset: 'atom' }).state;
    s = execute(s, { op: 'atom_set_view', scale_by: 10 }).state;
    expect(s.observer.size).toBeCloseTo(1e-11);
    expect(sizeForAtomZoom(atomZoomForSize(2e-9))).toBeCloseTo(2e-9);
  });
  it('helpers', () => {
    expect(routeForSize(1.7, 'village')).toBe('village');
    expect(routeForSize(1.7, 'cosmos')).toBe('nexus');
    expect(cosmicLayer(1e10)).toBe('solar');
    expect(cosmicLayer(3e21)).toBe('galactic');
    expect(cosmicLayer(8e24)).toBe('cosmic');
    expect(cosmosDisplayHeight(1.27e7)).toBeCloseTo(0.68, 5);
    expect(cosmosDisplayHeight(5e9)).toBeGreaterThan(3.2);
    expect(describeSize(1.4e10)).toMatch(/hold the Sun/);
    expect(validateCommands([{ op: 'set_scale' }]).issues[0].error).toMatch(/needs size_m/);
  });
  it('parses natural requests', () => {
    const w = createWorld();
    const ops = (t: string) => parseIntent(t, w).commands;
    expect(ops('ANANT, make me large enough to hold the Sun')).toEqual([{ op: 'set_scale', preset: 'hold_sun' }]);
    expect(ops('Shrink me to molecular size')).toEqual([{ op: 'set_scale', preset: 'molecule' }]);
    expect(ops('Make me smaller')).toEqual([{ op: 'set_scale', factor: 0.1 }]);
    expect(ops('Return me to human size')).toEqual([{ op: 'set_scale', preset: 'human' }]);
    expect(ops('Make me as large as Earth')).toEqual([{ op: 'set_scale', preset: 'earth' }]);
    expect(ops('Make me bigger than the Sun')).toEqual([{ op: 'set_scale', preset: 'sun' }]);
    expect(ops('Show me the entire solar system')).toEqual([{ op: 'set_scale', preset: 'solar_system' }]);
    expect(ops('Zoom out until I can see the Milky Way')).toEqual([{ op: 'set_scale', preset: 'milky_way' }]);
    expect(ops('Show me thousands of galaxies')).toEqual([{ op: 'set_scale', preset: 'galaxies' }]);
    expect(ops('Make me 100 meters tall')).toEqual([{ op: 'set_scale', size_m: 100 }]);
    expect(ops('Shrink me until I can see individual atoms')).toEqual([{ op: 'set_scale', preset: 'atoms' }]);
  });
});
