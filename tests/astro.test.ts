import { describe, it, expect } from 'vitest';
import { resolveAstro, ASTRO, viewSizeFor, formatDistance } from '../shared/astro';
import { createWorld, execute } from '../shared/worldState';
import { parseIntent } from '../shared/localParser';
import { cosmicLayer } from '../shared/scale';

describe('astronomical catalog', () => {
  it('resolves names and aliases', () => {
    expect(resolveAstro('Andromeda')?.id).toBe('andromeda');
    expect(resolveAstro('the Sombrero Galaxy')?.id).toBe('sombrero');
    expect(resolveAstro('pillars of creation')?.id).toBe('pillars');
    expect(resolveAstro('M87')?.id).toBe('m87');
    expect(resolveAstro('narnia')).toBeUndefined();
  });
  it('every object has a cited distance and a size', () => {
    for (const o of ASTRO) {
      expect(o.ref.length).toBeGreaterThan(3);
      expect((o.d_pc ?? o.d_mpc)!).toBeGreaterThan(0);
      expect(o.size_kpc).toBeGreaterThan(0);
    }
    expect(formatDistance(resolveAstro('andromeda')!)).toMatch(/2.50 million light-years/);
  });
  it('go_to_object enters the cosmos at a galaxy-framing size', () => {
    const r = execute(createWorld(), { op: 'go_to_object', name: 'andromeda' });
    expect(r.result.ok).toBe(true);
    expect(r.state.activeRealm).toBe('cosmos');
    expect(r.state.focus?.kind).toBe('astro');
    expect(cosmicLayer(r.state.observer.size)).toBe('galactic');
    expect(viewSizeFor(resolveAstro('orion')!)).toBeLessThan(2e19);
    expect(execute(createWorld(), { op: 'go_to_object', name: 'hogwarts' }).result.ok).toBe(false);
  });
  it('JWST search and natural language', () => {
    const r = execute(createWorld(), { op: 'find_objects', jwst: true });
    expect(r.result.message).toMatch(/Stephan's Quintet/);
    expect(r.result.message).not.toMatch(/Andromeda/);
    const w = createWorld();
    expect(parseIntent('Take me to Andromeda', w).commands).toEqual([{ op: 'go_to_object', name: 'andromeda' }]);
    expect(parseIntent('Show me the Sombrero Galaxy', w).commands).toEqual([{ op: 'go_to_object', name: 'sombrero' }]);
    expect(parseIntent('Find the Pillars of Creation', w).commands).toEqual([{ op: 'go_to_object', name: 'pillars' }]);
    expect(parseIntent('Show me galaxies observed by James Webb', w).commands).toEqual([{ op: 'find_objects', jwst: true }]);
    // existing phrases keep working
    expect(parseIntent('Show me a black hole', w).commands.at(-1)).toEqual({ op: 'cosmos_black_hole', show: true });
    expect(parseIntent('Take me to Europa', execute(w, { op: 'go_to_realm', realm: 'cosmos' }).state).commands).toEqual([{ op: 'camera_focus', target: 'jupiter' }]);
  });
});
