import { describe, it, expect } from 'vitest';
import { createWorld, execute, WorldState } from '../shared/worldState';
import { parseIntent } from '../shared/localParser';
import { compress, decompress, displayRadius, inverseDisplayRadius, NBody } from '../shared/physics';

const inCosmos = () => execute(createWorld(), { op: 'go_to_realm', realm: 'cosmos' }).state;
const body = (s: WorldState, id: string) => s.cosmos.bodies.find((b) => b.id === id)!;

describe('display compression', () => {
  it('is exactly invertible', () => {
    for (const r of [0.01, 0.39, 1, 5.2, 30, 90]) expect(inverseDisplayRadius(displayRadius(r))).toBeCloseTo(r, 9);
    const v: [number, number, number] = [3, -0.2, 4];
    decompress(compress(v)).forEach((x, i) => expect(x).toBeCloseTo(v[i], 9));
  });
});

describe('celestial manipulation', () => {
  it('sandbox: moving the Sun carries its planets', () => {
    let s = execute(inCosmos(), { op: 'cosmos_set_mode', mode: 'sandbox' }).state;
    const e0 = body(s, 'earth').pos, s0 = body(s, 'sun').pos;
    const r = execute(s, { op: 'cosmos_move_body', target: 'sun', position: [s0[0] + 4, s0[1], s0[2]] });
    expect(r.result.ok).toBe(true);
    expect(body(r.state, 'earth').pos[0]).toBeCloseTo(e0[0] + 4, 9);
    expect(r.state.cosmos.revision).toBe(1);
  });
  it('sandbox: a moved planet gets a bound circular orbit', () => {
    let s = execute(inCosmos(), { op: 'cosmos_set_mode', mode: 'sandbox' }).state;
    s = execute(s, { op: 'cosmos_move_body', target: 'mars', orbit_au: 2.5 }).state;
    const sim = new NBody(s.cosmos.bodies);
    const el = sim.orbitalElements(sim.index('mars'), sim.index('sun'));
    expect(el.a).toBeCloseTo(2.5, 1);
    expect(el.e).toBeLessThan(0.05);
  });
  it('physics: moving keeps velocity, so the orbit becomes eccentric', () => {
    const s0 = inCosmos();
    const v0 = body(s0, 'earth').vel;
    const s = execute(s0, { op: 'cosmos_move_body', target: 'earth', toward: 'mars', fraction: 0.4 }).state;
    expect(body(s, 'earth').vel).toEqual(v0);
    const sim = new NBody(s.cosmos.bodies);
    expect(sim.orbitalElements(sim.index('earth'), sim.index('sun')).e).toBeGreaterThan(0.05);
  });
  it('resizing is visual only; reset restores the system; grab/release', () => {
    let s = inCosmos();
    const m = body(s, 'saturn').mass;
    s = execute(s, { op: 'cosmos_set_body', target: 'saturn', radius_multiplier: 2 }).state;
    expect(body(s, 'saturn').mass).toBe(m);
    s = execute(s, { op: 'cosmos_move_body', target: 'jupiter', position: [9, 0, 9] }).state;
    const r = execute(s, { op: 'reset_system' });
    expect(body(r.state, 'jupiter').pos).toEqual(body(createWorld(), 'jupiter').pos);
    const g = execute(s, { op: 'cosmos_grab', target: 'sun' });
    expect(g.state.cosmos.grabbed).toBe('sun');
    expect(execute(g.state, { op: 'cosmos_grab', release: true }).state.cosmos.grabbed).toBeUndefined();
  });
  it('parses manipulation language', () => {
    const w = inCosmos();
    const ops = (t: string) => parseIntent(t, w).commands;
    expect(ops('Let me grab the Sun')).toEqual([{ op: 'cosmos_grab', target: 'sun' }]);
    expect(ops('Pick up Jupiter')).toEqual([{ op: 'cosmos_grab', target: 'jupiter' }]);
    expect(ops('Move Earth closer to Mars')).toEqual([{ op: 'cosmos_move_body', target: 'earth', toward: 'mars', fraction: 0.4 }]);
    expect(ops('Make Saturn twice as large')).toEqual([{ op: 'cosmos_set_body', target: 'saturn', radius_multiplier: 2 }]);
    expect(ops('Put this planet into a different orbit')).toEqual(ops('Put this planet into a different orbit')); // no crash
    expect(ops('Put Mars into a different orbit')).toEqual([{ op: 'cosmos_move_body', target: 'mars', orbit_au: 2.2 }]);
    expect(ops('Reset the solar system')).toEqual([{ op: 'reset_system' }]);
    expect(ops('Undo what I just did')).toEqual([{ op: 'undo' }]);
    expect(ops('switch to sandbox mode')).toEqual([{ op: 'cosmos_set_mode', mode: 'sandbox' }]);
    expect(ops('let go')).toEqual([{ op: 'cosmos_grab', release: true }]);
    // mass phrasing still means mass
    expect(ops('Make Jupiter twice as massive')).toEqual([{ op: 'cosmos_set_body', target: 'jupiter', mass_multiplier: 2 }]);
  });
});
