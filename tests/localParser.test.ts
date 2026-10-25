import { describe, it, expect } from 'vitest';
import { parseIntent } from '../shared/localParser';
import { createWorld, execute, WorldState } from '../shared/worldState';

const ops = (text: string, w: WorldState = createWorld()) => parseIntent(text, w).commands;
const inRealm = (realm: any) => execute(createWorld('t', 'w'), { op: 'go_to_realm', realm }).state;

describe('local fallback parser', () => {
  it('Scene 1: "Take me inside an atom."', () => {
    expect(ops('Take me inside an atom.')).toEqual([{ op: 'go_to_realm', realm: 'atom' }]);
  });
  it('orbital requests, with realm auto-travel', () => {
    expect(ops('Show me the 1s orbital')).toEqual([{ op: 'go_to_realm', realm: 'atom' }, { op: 'atom_set_orbital', n: 1, l: 0, m: 0 }]);
    expect(ops('Switch to a 2p orbital', inRealm('atom'))).toEqual([{ op: 'atom_set_orbital', n: 2, l: 1, m: 0 }]);
    expect(ops('show 2p_x', inRealm('atom'))).toEqual([{ op: 'atom_set_orbital', n: 2, l: 1, m: 1 }]);
    expect(ops('show me 3dxy', inRealm('atom'))).toEqual([{ op: 'atom_set_orbital', n: 3, l: 2, m: -2 }]);
    expect(ops('excite the electron to 3d', inRealm('atom'))).toEqual([{ op: 'atom_transition', n: 3, l: 2, m: 0 }]);
  });
  it('rejects non-existent orbitals honestly', () => {
    const r = parseIntent('show me the 1p orbital', inRealm('atom'));
    expect(r.commands).toEqual([]);
    expect(r.unsupported[0].reason).toMatch(/does not exist/);
  });
  it('atom view commands', () => {
    expect(ops('Increase the scale', inRealm('atom'))).toEqual([{ op: 'atom_set_view', scale_by: 1.5 }]);
    expect(ops('Show where the electron is most likely to be found', inRealm('atom'))).toEqual([{ op: 'atom_set_view', highlight_most_probable: true }]);
  });
  it('portals', () => {
    expect(ops('open a portal to space', inRealm('atom'))).toEqual([{ op: 'open_portal', to: 'cosmos' }]);
    expect(ops('Open a portal to a fantasy universe', inRealm('cosmos'))).toEqual([{ op: 'open_portal', to: 'village' }]);
    expect(ops('step through the portal')).toEqual([{ op: 'enter_portal' }]);
  });
  it('cosmos', () => {
    expect(ops('Create a miniature solar system')).toEqual([{ op: 'go_to_realm', realm: 'cosmos' }, { op: 'cosmos_create_system', preset: 'solar_system' }, { op: 'cosmos_set_sim', time_scale: 0.6 }]);
    expect(ops('Increase Jupiter\'s mass', inRealm('cosmos'))).toEqual([{ op: 'cosmos_set_body', target: 'jupiter', mass_multiplier: 100 }]);
    expect(ops('make jupiter 1000 times more massive', inRealm('cosmos'))).toEqual([{ op: 'cosmos_set_body', target: 'jupiter', mass_multiplier: 1000 }]);
    expect(ops('Make the third planet twice as massive', inRealm('cosmos'))).toEqual([{ op: 'cosmos_set_body', target: 'earth', mass_multiplier: 2 }]);
    expect(ops('Slow down the simulation', inRealm('cosmos'))[0]).toMatchObject({ op: 'cosmos_set_sim' });
    expect(ops('Show me a black hole')).toEqual([{ op: 'go_to_realm', realm: 'cosmos' }, { op: 'cosmos_black_hole', show: true }]);
  });
  it('Europa: honest partial support', () => {
    const r = parseIntent('Take me to Europa', inRealm('cosmos'));
    expect(r.commands).toEqual([{ op: 'camera_focus', target: 'jupiter' }]);
    expect(r.unsupported[0].reason).toMatch(/Moons are not simulated/);
  });
  it('reality creation', () => {
    expect(ops('Create a glowing sword')).toEqual([{ op: 'spawn_object', kind: 'sword', glow: true }]);
    expect(ops('Create a floating island above the village', inRealm('village'))).toEqual([{ op: 'spawn_object', kind: 'floating_island', placement: 'above', floating: true }]);
    expect(ops('summon a huge red dragon')[0]).toMatchObject({ op: 'spawn_object', kind: 'dragon', scale: 3, color: '#e0383e' });
  });
  it('manipulating existing objects', () => {
    let w = inRealm('village');
    w = execute(w, { op: 'spawn_object', kind: 'castle' }).state;
    expect(ops('Make the castle larger', w)).toEqual([{ op: 'transform_object', target: w.objects[0].id, scale_by: 1.6 }]);
    expect(ops('make it float', w)).toEqual([{ op: 'set_object_property', target: w.objects[0].id, floating: true }]);
    expect(ops('Put the castle on a floating island', w)).toEqual([
      { op: 'spawn_object', kind: 'floating_island', placement: 'above' },
      { op: 'transform_object', target: w.objects[0].id, place_on: 'floating_island' },
    ]);
  });
  it('environment, gravity and time', () => {
    expect(ops('Make the sky purple')).toEqual([{ op: 'set_environment', sky_color: '#8e44ff' }]);
    expect(ops('Create a storm')).toEqual([{ op: 'set_environment', weather: 'storm' }]);
    expect(ops('Make gravity weaker')).toEqual([{ op: 'set_gravity', multiplier: 0.3 }]);
    expect(ops('Freeze time')).toEqual([{ op: 'set_time', frozen: true }]);
  });
  it('story', () => {
    expect(ops('let me talk to the innkeeper')).toEqual([{ op: 'go_to_realm', realm: 'village' }, { op: 'talk_to', npc: 'maera' }]);
    expect(ops('accuse Seren', inRealm('village'))).toEqual([{ op: 'accuse', npc: 'seren' }]);
    const king = parseIntent('Let me talk to the king', inRealm('village'));
    expect(king.commands).toEqual([]);
    expect(king.unsupported[0].suggestion).toMatch(/Ilsa/);
  });
  it('multi-clause requests', () => {
    expect(ops('take me to the village and then make it night')).toEqual([{ op: 'go_to_realm', realm: 'village' }, { op: 'set_environment', time_of_day: 'night' }]);
  });
  it('honestly reports unsupported requests', () => {
    const r = parseIntent('Show me what happened here 100 years ago', inRealm('village'));
    expect(r.commands).toEqual([]);
    expect(r.unsupported).toHaveLength(1);
    const g = parseIntent('xyzzy plugh', createWorld());
    expect(g.unsupported[0].suggestion).toBeTruthy();
  });
  it('every parse output survives the reducer without throwing', () => {
    const phrases = ['Take me inside an atom', 'switch to 3d', 'open a portal to space', 'enter the portal', 'create a solar system', 'increase jupiter mass', 'open a portal to the village', 'go through the portal', 'talk to Doran', 'create a floating island above the village', 'make it bigger', 'make the sky purple', 'summon a dragon', 'freeze time'];
    let w = createWorld();
    for (const p of phrases) for (const c of parseIntent(p, w).commands) w = execute(w, c).state;
    expect(w.activeRealm).toBe('village');
    expect(w.objects.some((o) => o.kind === 'dragon')).toBe(true);
    expect(w.time.frozen).toBe(true);
  });
});

describe('powers-of-ten zoom phrases', () => {
  it('maps scale journeys to atom_set_view', () => {
    expect(ops('Show me a water molecule')).toEqual([{ op: 'go_to_realm', realm: 'atom' }, { op: 'atom_set_view', scale: 0.35 }]);
    expect(ops('take me inside the proton', inRealm('atom'))).toEqual([{ op: 'atom_set_view', scale: 150000 }]);
    expect(ops('zoom out to liquid water', inRealm('atom'))).toEqual([{ op: 'atom_set_view', scale: 0.06 }]);
    expect(ops('back to the single atom', inRealm('atom'))).toEqual([{ op: 'atom_set_view', scale: 1 }]);
  });
});
