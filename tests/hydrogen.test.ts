import { describe, it, expect } from 'vitest';
import { radial, radialProbability, realY, mostProbableRadius, expectedRadius, sampleOrbital, transitionWavelengthNm, energyEV, describeTransition, psi } from '../shared/hydrogen';

const integrate = (f: (x: number) => number, a: number, b: number, n = 20000) => {
  const h = (b - a) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += f(a + (i + 0.5) * h);
  return s * h;
};

describe('hydrogen wavefunctions', () => {
  const states = [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2], [4, 0], [4, 3]];
  it.each(states)('R_%i%i is normalised', (n, l) => {
    expect(integrate((r) => radialProbability(n, l, r), 0, 120)).toBeCloseTo(1, 4);
  });

  it('matches the closed form R_10 = 2 e^{-r}', () => {
    for (const r of [0.1, 1, 2.5]) expect(radial(1, 0, r)).toBeCloseTo(2 * Math.exp(-r), 10);
  });

  it('real spherical harmonics are normalised on the sphere', () => {
    for (const [l, m] of [[0, 0], [1, 0], [1, 1], [2, -2], [3, 2]]) {
      let s = 0;
      const N = 200;
      for (let i = 0; i < N; i++) for (let j = 0; j < 2 * N; j++) {
        const th = ((i + 0.5) / N) * Math.PI, ph = ((j + 0.5) / (2 * N)) * 2 * Math.PI;
        s += realY(l, m, th, ph) ** 2 * Math.sin(th) * (Math.PI / N) * (Math.PI / N);
      }
      expect(s).toBeCloseTo(1, 3);
    }
  });

  it('most probable radii: 1s→1 a₀, 2p→4 a₀, 3d→9 a₀', () => {
    expect(mostProbableRadius(1, 0)).toBeCloseTo(1, 2);
    expect(mostProbableRadius(2, 1)).toBeCloseTo(4, 2);
    expect(mostProbableRadius(3, 2)).toBeCloseTo(9, 2);
  });

  it('Monte-Carlo samples reproduce ⟨r⟩ = 1.5 a₀ for 1s and 5 a₀ for 2p', () => {
    for (const [n, l, m] of [[1, 0, 0], [2, 1, 0]]) {
      const s = sampleOrbital(n, l, m, 40000, 7);
      let sum = 0;
      for (let k = 0; k < s.count; k++) sum += Math.hypot(s.positions[3 * k], s.positions[3 * k + 1], s.positions[3 * k + 2]);
      expect(sum / s.count).toBeCloseTo(expectedRadius(n, l), 1);
    }
  });

  it('2p_z has a nodal plane: almost no samples near z = 0, and lobes have opposite sign', () => {
    const s = sampleOrbital(2, 1, 0, 20000, 3);
    let near = 0, posUp = 0, up = 0;
    for (let k = 0; k < s.count; k++) {
      const z = s.positions[3 * k + 1]; // physics z is stored as scene y
      if (Math.abs(z) < 0.05) near++;
      if (z > 0.5) { up++; if (s.sign[k] > 0) posUp++; }
    }
    expect(near / s.count).toBeLessThan(0.01);
    expect(posUp / up).toBeGreaterThan(0.99);
    expect(psi(2, 1, 0, 0, 0, 1) * psi(2, 1, 0, 0, 0, -1)).toBeLessThan(0);
  });

  it('spectroscopy: Lyman-α 121.6 nm, Balmer Hα 656.5 nm, E1 = −13.6 eV', () => {
    expect(transitionWavelengthNm(2, 1)).toBeCloseTo(121.57, 1);
    expect(transitionWavelengthNm(3, 2)).toBeCloseTo(656.5, 0);
    expect(energyEV(1)).toBeCloseTo(-13.606, 3);
    const d = describeTransition({ n: 3, l: 1 }, { n: 2, l: 0 });
    expect(d.band).toBe('visible');
    expect(d.series).toBe('Balmer');
    expect(d.dipoleAllowed).toBe(true);
  });
});
