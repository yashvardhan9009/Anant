import { describe, it, expect } from 'vitest';
import { createWorld, execute, resolveObject, WorldState } from '../shared/worldState';
import type { Command } from '../shared/commands';

const run = (s: WorldState, ...cmds: Command[]) => {
  const results = [];
  for (const c of cmds) {
    const r = execute(s, c, { now: 1000 });
    s = r.state;
    results.push(r.result);
  }
  return { s, results };
};

describe('world state reducer', () => {
  it('travels between realms and logs history', () => {
    const { s, results } = run(createWorld('t', 'w1'), { op: 'go_to_realm', realm: 'atom' });
    expect(results[0].ok).toBe(true);
    expect(s.activeRealm).toBe('atom');
    expect(s.history.at(-1)?.op).toBe('go_to_realm');
  });

  it('spawns, transforms, recolours and deletes objects by name/kind/selection', () => {
    let { s } = run(createWorld('t', 'w1'), { op: 'go_to_realm', realm: 'village' }, { op: 'spawn_object', kind: 'castle' });
    const castle = s.objects[0];
    expect(castle.realm).toBe('village');
    expect(s.selectedId).toBe(castle.id);
    ({ s } = run(s, { op: 'transform_object', target: 'castle', scale_by: 2 }));
    expect(s.objects[0].scale).toBeCloseTo(3.2);
    ({ s } = run(s, { op: 'set_object_property', target: 'selected', color: '#112233' }));
    expect(s.objects[0].color).toBe('#112233');
    const r = run(s, { op: 'delete_object', target: 'Castle' });
    expect(r.s.objects).toHaveLength(0);
  });

  it('places one object on top of another', () => {
    const { s, results } = run(createWorld('t', 'w1'), { op: 'go_to_realm', realm: 'village' }, { op: 'spawn_object', kind: 'floating_island', placement: 'above' }, { op: 'spawn_object', kind: 'castle' }, { op: 'transform_object', target: 'last', place_on: 'floating_island' });
    expect(results.every((r) => r.ok)).toBe(true);
    const island = s.objects.find((o) => o.kind === 'floating_island')!;
    const castle = s.objects.find((o) => o.kind === 'castle')!;
    expect(castle.position[0]).toBe(island.position[0]);
    expect(castle.position[1]).toBeGreaterThan(island.position[1]);
    expect(castle.floating).toBe(true);
  });

  it('does not change state when an operation fails', () => {
    const s0 = createWorld('t', 'w1');
    const r = execute(s0, { op: 'transform_object', target: 'nonexistent', scale_by: 2 });
    expect(r.result.ok).toBe(false);
    expect(r.state).toBe(s0);
    expect(s0.history).toHaveLength(0);
  });

  it('objects are scoped to their realm', () => {
    let { s } = run(createWorld('t', 'w1'), { op: 'spawn_object', kind: 'orb' }, { op: 'go_to_realm', realm: 'village' });
    expect(resolveObject(s, 'orb')).toBeUndefined();
  });

  it('portals: open, enter, keep a linked return portal, close', () => {
    let { s, results } = run(createWorld('t', 'w1'), { op: 'go_to_realm', realm: 'atom' }, { op: 'open_portal', to: 'cosmos' }, { op: 'enter_portal' });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(s.activeRealm).toBe('cosmos');
    const there = s.portals.find((p) => p.from === 'atom')!;
    const back = s.portals.find((p) => p.from === 'cosmos' && p.to === 'atom')!;
    expect(back.linkedPortalId).toBe(there.id);
    expect(there.linkedPortalId).toBe(back.id);
    // Going back through reuses the same return portal rather than creating another.
    ({ s } = run(s, { op: 'enter_portal', portal: back.id }));
    expect(s.activeRealm).toBe('atom');
    expect(s.portals).toHaveLength(2);
    // Cannot open a portal to where you are.
    expect(execute(s, { op: 'open_portal', to: 'atom' }).result.ok).toBe(false);
    ({ s } = run(s, { op: 'close_portal', portal: there.id }));
    expect(s.portals.find((p) => p.id === back.id)?.linkedPortalId).toBeUndefined();
  });

  it('enter_portal fails cleanly with no portal', () => {
    const r = execute(createWorld(), { op: 'enter_portal' });
    expect(r.result.ok).toBe(false);
    expect(r.result.message).toMatch(/no open portal/i);
  });

  it('atom transitions compute real photon wavelengths', () => {
    let { s, results } = run(createWorld('t', 'w1'), { op: 'atom_set_orbital', n: 2, l: 1, m: 0 }, { op: 'atom_transition', n: 1, l: 0, m: 0 });
    expect(results[1].ok).toBe(true);
    expect(s.atom.transition!.lambda).toBeCloseTo(121.6, 0);
    expect(results[1].message).toMatch(/Emits a 121\.\d nm ultraviolet photon \(Lyman/);
    ({ s, results } = run(s, { op: 'atom_transition', n: 3, l: 2, m: 0 }));
    expect(results[0].message).toMatch(/Absorbs/);
    expect(results[0].message).toMatch(/forbidden/); // s → d is Δl = 2
  });

  it('cosmos: mass changes, adding/removing bodies, presets', () => {
    let { s, results } = run(createWorld('t', 'w1'), { op: 'go_to_realm', realm: 'cosmos' }, { op: 'cosmos_set_body', target: 'Jupiter', mass_multiplier: 1000 });
    expect(results[1].ok).toBe(true);
    expect(s.cosmos.bodies.find((b) => b.id === 'jupiter')!.mass).toBeCloseTo(0.9545, 3);
    ({ s, results } = run(s, { op: 'cosmos_add_body', name: 'Nova', mass: 3e-6, distance: 2 }));
    expect(s.cosmos.bodies.some((b) => b.name === 'Nova')).toBe(true);
    const epoch = s.cosmos.epoch;
    ({ s } = run(s, { op: 'cosmos_create_system', preset: 'binary_star' }));
    expect(s.cosmos.epoch).toBe(epoch + 1);
    expect(s.cosmos.bodies.filter((b) => b.kind === 'star')).toHaveLength(2);
    expect(execute(s, { op: 'cosmos_set_body', target: 'pluto', mass_multiplier: 2 }).result.ok).toBe(false);
  });

  it('talk_to requires the village and a real NPC; accuse has consequences once', () => {
    let s = createWorld('t', 'w1');
    expect(execute(s, { op: 'talk_to', npc: 'maera' }).result.ok).toBe(false);
    ({ s } = run(s, { op: 'go_to_realm', realm: 'village' }));
    expect(execute(s, { op: 'talk_to', npc: 'the king' }).result.ok).toBe(false);
    const t = execute(s, { op: 'talk_to', npc: 'innkeeper' });
    expect(t.result.ok).toBe(true);
    expect(t.state.story.activeConversation).toBe('maera');
    ({ s } = run(s, { op: 'accuse', npc: 'doran' }));
    expect(s.story.outcome?.kind).toBe('injustice');
    expect(s.story.npcs.doran.arrested).toBe(true);
    expect(execute(s, { op: 'accuse', npc: 'seren' }).result.ok).toBe(false);
    expect(execute(s, { op: 'talk_to', npc: 'doran' }).result.ok).toBe(false);
  });

  it('state is JSON-serialisable and round-trips', () => {
    const { s } = run(createWorld('t', 'w1'), { op: 'spawn_object', kind: 'dragon' }, { op: 'open_portal', to: 'village' });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('scientific honesty in the reducer', () => {
  it('refuses weather inside the atom and gravity on the electron', () => {
    const s = execute(createWorld(), { op: 'go_to_realm', realm: 'atom' }).state;
    expect(execute(s, { op: 'set_environment', weather: 'storm' }).result.ok).toBe(false);
    expect(execute(s, { op: 'set_gravity', multiplier: 0.2 }).result.message).toMatch(/weaker than the electric force/);
    // sky colour is purely visual and still allowed
    expect(execute(s, { op: 'set_environment', sky_color: '#220044' }).result.ok).toBe(true);
  });
  it('portals open facing the camera yaw', () => {
    const r = execute(createWorld(), { op: 'open_portal', to: 'atom' }, { yaw: 1.2, inFront: [1, 1, -5] });
    expect(r.state.portals[0].yaw).toBe(1.2);
    expect(r.state.portals[0].position[1]).toBeGreaterThanOrEqual(2.2);
  });
});
