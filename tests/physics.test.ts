import { describe, it, expect } from 'vitest';
import { NBody, makePreset, G_AU } from '../shared/physics';

describe('N-body simulation', () => {
  it('Earth around the Sun has a ~1 year period (Kepler III in AU/yr/M☉ units)', () => {
    const sim = new NBody(makePreset('solar_system'));
    const { a, e, period } = sim.orbitalElements(sim.index('earth'), sim.index('sun'));
    expect(a).toBeCloseTo(1, 2);
    expect(e).toBeLessThan(0.01);
    expect(period).toBeCloseTo(1, 2);
  });

  it('conserves energy to < 1e-5 relative over 20 simulated years (velocity Verlet)', () => {
    const sim = new NBody(makePreset('inner_planets'));
    const e0 = sim.energy();
    sim.advance(20, 0.0005, 1e6);
    expect(Math.abs((sim.energy() - e0) / e0)).toBeLessThan(1e-5);
  });

  it('Earth returns near its starting point after one year', () => {
    const sim = new NBody(makePreset('solar_system'));
    const i = sim.index('earth');
    const p0 = sim.getPos(i);
    sim.advance(1, 0.0005, 1e6);
    const p1 = sim.getPos(i);
    expect(Math.hypot(p1[0] - p0[0], p1[2] - p0[2])).toBeLessThan(0.03);
  });

  it('a 1000× more massive Jupiter visibly perturbs the inner planets', () => {
    const a = new NBody(makePreset('solar_system'));
    const b = new NBody(makePreset('solar_system'));
    b.mass[b.index('jupiter')] *= 1000;
    a.advance(5, 0.0005, 1e6);
    b.advance(5, 0.0005, 1e6);
    const ea = a.orbitalElements(a.index('mars'), a.index('sun')).e;
    const eb = b.orbitalElements(b.index('mars'), b.index('sun')).e;
    expect(eb).toBeGreaterThan(ea + 0.02);
  });

  it('gravity scale changes forces linearly', () => {
    const sim = new NBody(makePreset('empty').concat([{ id: 'p', name: 'p', mass: 1e-9, pos: [1, 0, 0], vel: [0, 0, 0], color: '#fff', kind: 'planet', radius: 1 }]));
    sim.computeAcc();
    const a1 = sim.acc[3];
    sim.gScale = 0.5;
    sim.computeAcc();
    expect(sim.acc[3] / a1).toBeCloseTo(0.5, 6);
    expect(Math.abs(a1)).toBeCloseTo(G_AU, 1);
  });

  it('binary preset has zero net momentum', () => {
    const bodies = makePreset('binary_star');
    const p = [0, 1, 2].map((k) => bodies.reduce((s, b) => s + b.mass * b.vel[k], 0));
    p.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-12));
  });
});
