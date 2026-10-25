import { describe, it, expect } from 'vitest';
import { validateCommands, orbitalName } from '../shared/commands';

describe('command validation', () => {
  it('accepts well-formed commands', () => {
    const { valid, issues } = validateCommands([
      { op: 'go_to_realm', realm: 'atom' },
      { op: 'atom_set_orbital', n: 2, l: 1, m: 0 },
      { op: 'spawn_object', kind: 'castle', color: '#ff0000', scale: 2 },
    ]);
    expect(issues).toEqual([]);
    expect(valid).toHaveLength(3);
  });
  it('rejects unknown ops, bad params and impossible quantum numbers', () => {
    const { valid, issues } = validateCommands([
      { op: 'rm_rf', path: '/' },
      { op: 'spawn_object', kind: 'spaceship' },
      { op: 'atom_set_orbital', n: 1, l: 1, m: 0 },
      { op: 'atom_set_orbital', n: 3, l: 1, m: 2 },
      { op: 'spawn_object', kind: 'orb', color: 'red' },
      { op: 'transform_object', target: 'castle' },
      { op: 'set_gravity', multiplier: 1e9 },
    ]);
    expect(valid).toHaveLength(0);
    expect(issues).toHaveLength(7);
    expect(issues[2].error).toMatch(/l \(1\) must be < n/);
  });
  it('rejects non-arrays and caps list length', () => {
    expect(validateCommands('nope').issues[0].error).toMatch(/array/);
    const many = Array.from({ length: 20 }, () => ({ op: 'set_time', frozen: true }));
    const r = validateCommands(many);
    expect(r.valid).toHaveLength(12);
    expect(r.issues.some((i) => /too many/.test(i.error))).toBe(true);
  });
  it('names orbitals', () => {
    expect(orbitalName(1, 0, 0)).toBe('1s');
    expect(orbitalName(2, 1, 1)).toBe('2p_x');
    expect(orbitalName(3, 2, 0)).toBe('3d_z²');
  });
});
