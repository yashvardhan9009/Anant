/**
 * Authoritative world state + deterministic reducer.
 *
 * `execute(state, command)` is the ONLY way a world changes. It returns the new
 * state plus a result that says whether the engine actually performed the
 * operation. The UI never reports success unless `result.ok` is true.
 */
import type { Command, RealmId, ObjectKind } from './commands.js';
import { REALM_INFO, orbitalName } from './commands.js';
import { makePreset, BodyDef, G_AU } from './physics.js';
import { describeTransition, mostProbableRadius } from './hydrogen.js';
import { initialStory, StoryState, resolveNpc, accuse as storyAccuse } from './story.js';
import { SCALE_PRESETS, ScalePreset, clampSize, routeForSize, atomZoomForSize, sizeForAtomZoom, describeSize, HUMAN } from './scale.js';

export type Vec3 = [number, number, number];

export interface SceneObject {
  id: string;
  realm: RealmId;
  kind: ObjectKind;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  color: string;
  glow: boolean;
  floating: boolean;
  createdAt: number;
}

export interface Env {
  skyColor?: string;
  weather: 'clear' | 'storm' | 'rain' | 'snow' | 'aurora';
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night';
  fog: number;
  gravity: number;
}

export interface Portal {
  id: string;
  from: RealmId;
  to: RealmId;
  position: Vec3;
  /** the portal on the other side that leads back */
  linkedPortalId?: string;
  /** facing direction (radians around +Y) */
  yaw?: number;
  createdAt: number;
}

export interface HistoryEntry {
  t: number;
  realm: RealmId;
  op: string;
  summary: string;
}

export interface WorldState {
  schema: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  activeRealm: RealmId;
  objects: SceneObject[];
  env: Record<RealmId, Env>;
  portals: Portal[];
  time: { frozen: boolean; scale: number };
  atom: {
    n: number; l: number; m: number;
    scale: number;
    showNucleus: boolean;
    highlight: boolean;
    slice: boolean;
    transition?: { id: number; from: [number, number, number]; to: [number, number, number]; lambda: number; kind: string; dE: number };
  };
  cosmos: {
    preset: string;
    epoch: number; // bumps when a whole new system is created
    bodies: BodyDef[];
    timeScale: number;
    paused: boolean;
    trails: boolean;
    blackHole: boolean;
  };
  story: StoryState;
  /** the user's apparent size in metres (separate from mass, time and gravity) */
  observer: { size: number };
  selectedId?: string;
  focus?: { kind: 'object' | 'body' | 'npc'; id: string; seq: number };
  seq: number;
  history: HistoryEntry[];
}

export interface ExecContext {
  /** where "in front of the user" is in the current realm (from the camera) */
  inFront?: Vec3;
  /** camera yaw, so portals open facing the user */
  yaw?: number;
  now?: number;
}

export interface ExecResult {
  ok: boolean;
  op: string;
  message: string;
  data?: Record<string, unknown>;
}

const DEFAULT_ENV: Record<RealmId, Env> = {
  nexus: { weather: 'clear', timeOfDay: 'night', fog: 0.25, gravity: 1 },
  atom: { weather: 'clear', timeOfDay: 'night', fog: 0, gravity: 1 },
  cosmos: { weather: 'clear', timeOfDay: 'night', fog: 0, gravity: 1 },
  village: { weather: 'clear', timeOfDay: 'dusk', fog: 0.45, gravity: 1 },
};

/** Where a traveller arrives in each realm (the return portal stands just behind them). */
export const ARRIVAL: Record<RealmId, Vec3> = {
  nexus: [0, 2.4, 19.5],
  atom: [0, 2.2, 16],
  cosmos: [0, 2.2, 34],
  village: [2.5, 2.6, 30],
};

const KIND_COLORS: Record<ObjectKind, string> = {
  castle: '#cfc6b8', floating_island: '#6f9b5a', sword: '#9fd8ff', crystal: '#a46bff', tree: '#3f8f4f', tower: '#b9b2a6',
  orb: '#ffcc66', dragon: '#c0392b', monolith: '#1a1a24', lantern: '#ffb347', statue: '#d8d2c4', bridge: '#8b6b4a',
};

const PRETTY: Record<ObjectKind, string> = {
  castle: 'Castle', floating_island: 'Floating Island', sword: 'Sword', crystal: 'Crystal', tree: 'Tree', tower: 'Tower',
  orb: 'Orb', dragon: 'Dragon', monolith: 'Monolith', lantern: 'Lantern', statue: 'Statue', bridge: 'Bridge',
};

export function createWorld(name = 'My Universe', id = `world-${Date.now().toString(36)}`): WorldState {
  const now = Date.now();
  return {
    schema: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    activeRealm: 'nexus',
    objects: [],
    env: structuredClone(DEFAULT_ENV),
    portals: [],
    time: { frozen: false, scale: 1 },
    atom: { n: 1, l: 0, m: 0, scale: 1, showNucleus: true, highlight: false, slice: false },
    cosmos: { preset: 'solar_system', epoch: 1, bodies: makePreset('solar_system'), timeScale: 0.5, paused: false, trails: true, blackHole: false },
    story: initialStory(),
    observer: { size: HUMAN },
    seq: 0,
    history: [],
  };
}

const realmTitle = (r: RealmId) => REALM_INFO[r].title;

function log(s: WorldState, op: string, summary: string, now: number) {
  s.history.push({ t: now, realm: s.activeRealm, op, summary });
  if (s.history.length > 500) s.history.splice(0, s.history.length - 500);
}

function placementFor(s: WorldState, kind: ObjectKind, placement: string | undefined, ctx: ExecContext): Vec3 {
  const realm = s.activeRealm;
  const front = ctx.inFront ?? (realm === 'village' ? [0, 2, -10] : [0, 1.5, -8]);
  const villageCentre: Vec3 = [0, 0, -6];
  switch (placement) {
    case 'above':
    case 'sky':
      return realm === 'village' ? [villageCentre[0], kind === 'floating_island' ? 26 : 18, villageCentre[2] - 10] : [front[0], front[1] + 10, front[2]];
    case 'ground':
      return [front[0], 0, front[2]];
    case 'left':
      return [front[0] - 6, front[1], front[2]];
    case 'right':
      return [front[0] + 6, front[1], front[2]];
    case 'behind':
      return [-front[0], front[1], -front[2]];
    case 'center':
      return [0, front[1], 0];
    default:
      if (kind === 'floating_island') return realm === 'village' ? [0, 24, -18] : [front[0], front[1] + 6, front[2] - 4];
      if (kind === 'castle' || kind === 'tower') return [front[0], 0, front[2] - 6];
      if (kind === 'dragon') return [front[0], front[1] + 8, front[2] - 4];
      return front as Vec3;
  }
}

export function resolveObject(s: WorldState, target: string): SceneObject | undefined {
  const t = target.toLowerCase().trim().replace(/^the\s+/, '');
  const inRealm = s.objects.filter((o) => o.realm === s.activeRealm);
  if (['selected', 'it', 'this', 'that', 'them'].includes(t) && s.selectedId) {
    const sel = inRealm.find((o) => o.id === s.selectedId);
    if (sel) return sel;
  }
  if (['last', 'it', 'this', 'that', 'selected'].includes(t)) return inRealm[inRealm.length - 1];
  const norm = t.replace(/\s+/g, '_');
  return (
    inRealm.find((o) => o.id === t) ??
    [...inRealm].reverse().find((o) => o.name.toLowerCase() === t) ??
    [...inRealm].reverse().find((o) => o.kind === norm || o.kind === norm.replace(/s$/, '')) ??
    [...inRealm].reverse().find((o) => o.name.toLowerCase().includes(t) || t.includes(o.name.toLowerCase()) || t.includes(o.kind.replace('_', ' ')))
  );
}

export function resolveBody(s: WorldState, target: string): BodyDef | undefined {
  const t = target.toLowerCase().trim().replace(/^the\s+/, '');
  if (t === 'star' || t === 'sun') return s.cosmos.bodies.find((b) => b.kind === 'star');
  return s.cosmos.bodies.find((b) => b.id === t || b.name.toLowerCase() === t) ?? s.cosmos.bodies.find((b) => b.name.toLowerCase().includes(t));
}

/** Height of an object's top surface above its origin (matches the procedural generators). */
export function surfaceHeight(o: SceneObject): number {
  const h: Partial<Record<ObjectKind, number>> = { floating_island: 0.55, castle: 4.2, tower: 7, monolith: 6, statue: 2.6, bridge: 0.6 };
  return (h[o.kind] ?? 1) * o.scale;
}

const fail = (op: string, message: string): ExecResult => ({ ok: false, op, message });

export function execute(prev: WorldState, cmd: Command, ctx: ExecContext = {}): { state: WorldState; result: ExecResult } {
  const s: WorldState = structuredClone(prev);
  const now = ctx.now ?? Date.now();
  const nextId = (prefix: string) => `${prefix}-${++s.seq}`;
  let result: ExecResult;

  switch (cmd.op) {
    case 'go_to_realm': {
      if (s.activeRealm === cmd.realm) {
        result = { ok: true, op: cmd.op, message: `You are already in ${realmTitle(cmd.realm)}.`, data: { from: cmd.realm, to: cmd.realm } };
        break;
      }
      const from = s.activeRealm;
      s.activeRealm = cmd.realm;
      s.selectedId = undefined;
      result = { ok: true, op: cmd.op, message: `Travelling from ${realmTitle(from)} to ${realmTitle(cmd.realm)}.`, data: { from, to: cmd.realm } };
      break;
    }
    case 'open_portal': {
      if (cmd.to === s.activeRealm) {
        result = fail(cmd.op, `You are already in ${realmTitle(cmd.to)} — a portal must lead somewhere else.`);
        break;
      }
      const here = s.portals.filter((p) => p.from === s.activeRealm);
      if (here.length >= 4) s.portals = s.portals.filter((p) => p.id !== here[0].id);
      const pos: Vec3 = cmd.position ?? (ctx.inFront ? [ctx.inFront[0], Math.max(2.2, ctx.inFront[1]), ctx.inFront[2]] : [0, 2.2, -6]);
      const portal: Portal = { id: nextId('portal'), from: s.activeRealm, to: cmd.to, position: pos, yaw: ctx.yaw ?? 0, createdAt: now };
      s.portals.push(portal);
      result = { ok: true, op: cmd.op, message: `A portal to ${realmTitle(cmd.to)} tears open.`, data: { portal: portal.id, to: cmd.to } };
      break;
    }
    case 'enter_portal': {
      const here = s.portals.filter((p) => p.from === s.activeRealm);
      const portal = cmd.portal ? here.find((p) => p.id === cmd.portal) : here[here.length - 1];
      if (!portal) {
        result = fail(cmd.op, here.length ? `No portal "${cmd.portal}" here.` : 'There is no open portal here. Draw a circle or say "open a portal to …" first.');
        break;
      }
      const from = s.activeRealm;
      s.activeRealm = portal.to;
      s.selectedId = undefined;
      // Keep the connection: ensure a return portal exists on the far side.
      let back = s.portals.find((p) => p.id === portal.linkedPortalId) ?? s.portals.find((p) => p.from === portal.to && p.to === from);
      if (!back) {
        back = { id: nextId('portal'), from: portal.to, to: from, position: ARRIVAL[portal.to], yaw: Math.atan2(-ARRIVAL[portal.to][0], -ARRIVAL[portal.to][2]), linkedPortalId: portal.id, createdAt: now };
        s.portals.push(back);
      }
      portal.linkedPortalId = back.id;
      back.linkedPortalId = portal.id;
      result = { ok: true, op: cmd.op, message: `You step through into ${realmTitle(portal.to)}. The way back to ${realmTitle(from)} stays open behind you.`, data: { from, to: portal.to, portal: portal.id, returnPortal: back.id } };
      break;
    }
    case 'close_portal': {
      const p = s.portals.find((x) => x.id === cmd.portal || (cmd.portal === 'last' && x.from === s.activeRealm));
      if (!p) { result = fail(cmd.op, `No portal "${cmd.portal}".`); break; }
      s.portals = s.portals.filter((x) => x.id !== p.id);
      s.portals.forEach((x) => { if (x.linkedPortalId === p.id) x.linkedPortalId = undefined; });
      result = { ok: true, op: cmd.op, message: `The portal to ${realmTitle(p.to)} collapses.`, data: { portal: p.id } };
      break;
    }
    case 'spawn_object': {
      if (s.activeRealm === 'atom' || s.activeRealm === 'cosmos') {
        // Scientific realms stay uncluttered by fantasy props unless explicitly placed.
        if (!cmd.position && !cmd.placement && cmd.kind !== 'orb' && cmd.kind !== 'crystal') {
          // still allowed — imagination can intrude on science, but we say so.
        }
      }
      const count = s.objects.filter((o) => o.kind === cmd.kind).length;
      const obj: SceneObject = {
        id: nextId(cmd.kind.replace('_', '-')),
        realm: s.activeRealm,
        kind: cmd.kind,
        name: cmd.name ?? (count ? `${PRETTY[cmd.kind]} ${count + 1}` : PRETTY[cmd.kind]),
        position: cmd.position ?? placementFor(s, cmd.kind, cmd.placement, ctx),
        rotation: [0, 0, 0],
        scale: cmd.scale ?? (cmd.kind === 'floating_island' ? 2.2 : cmd.kind === 'castle' ? 1.6 : 1),
        color: cmd.color ?? KIND_COLORS[cmd.kind],
        glow: cmd.glow ?? ['sword', 'crystal', 'orb', 'lantern'].includes(cmd.kind),
        floating: cmd.floating ?? ['floating_island', 'orb', 'crystal'].includes(cmd.kind),
        createdAt: now,
      };
      s.objects.push(obj);
      s.selectedId = obj.id;
      const note = s.activeRealm === 'atom' || s.activeRealm === 'cosmos' ? ' (an imaginative object inside a scientific realm — not part of the simulation)' : '';
      result = { ok: true, op: cmd.op, message: `Created ${obj.name}${note}.`, data: { id: obj.id, kind: obj.kind } };
      break;
    }
    case 'transform_object': {
      const o = resolveObject(s, cmd.target);
      if (!o) { result = fail(cmd.op, `I can't find "${cmd.target}" in ${realmTitle(s.activeRealm)}.`); break; }
      if (cmd.scale_to !== undefined) o.scale = cmd.scale_to;
      if (cmd.scale_by !== undefined) o.scale = Math.min(50, Math.max(0.05, o.scale * cmd.scale_by));
      if (cmd.move_to) o.position = [...cmd.move_to];
      if (cmd.move_by) o.position = [o.position[0] + cmd.move_by[0], o.position[1] + cmd.move_by[1], o.position[2] + cmd.move_by[2]];
      if (cmd.place_on) {
        const base = resolveObject(s, cmd.place_on);
        if (!base || base.id === o.id) { result = fail(cmd.op, `I can't find "${cmd.place_on}" to place ${o.name} on.`); break; }
        o.position = [base.position[0], base.position[1] + surfaceHeight(base), base.position[2]];
        o.floating = base.floating;
      }
      if (cmd.rotate_by) o.rotation = [o.rotation[0] + cmd.rotate_by[0], o.rotation[1] + cmd.rotate_by[1], o.rotation[2] + cmd.rotate_by[2]];
      s.selectedId = o.id;
      result = { ok: true, op: cmd.op, message: `${o.name} transformed (scale ${o.scale.toFixed(2)}).`, data: { id: o.id } };
      break;
    }
    case 'set_object_property': {
      const o = resolveObject(s, cmd.target);
      if (!o) { result = fail(cmd.op, `I can't find "${cmd.target}" in ${realmTitle(s.activeRealm)}.`); break; }
      if (cmd.color) o.color = cmd.color;
      if (cmd.glow !== undefined) o.glow = cmd.glow;
      if (cmd.floating !== undefined) o.floating = cmd.floating;
      if (cmd.name) o.name = cmd.name;
      s.selectedId = o.id;
      result = { ok: true, op: cmd.op, message: `${o.name} updated.`, data: { id: o.id } };
      break;
    }
    case 'delete_object': {
      const o = resolveObject(s, cmd.target);
      if (!o) { result = fail(cmd.op, `I can't find "${cmd.target}".`); break; }
      s.objects = s.objects.filter((x) => x.id !== o.id);
      if (s.selectedId === o.id) s.selectedId = undefined;
      result = { ok: true, op: cmd.op, message: `${o.name} dissolves.`, data: { id: o.id } };
      break;
    }
    case 'select_object': {
      const o = resolveObject(s, cmd.target);
      if (!o) { result = fail(cmd.op, `I can't find "${cmd.target}".`); break; }
      s.selectedId = o.id;
      result = { ok: true, op: cmd.op, message: `${o.name} selected — pinch to grab it.`, data: { id: o.id } };
      break;
    }
    case 'set_environment': {
      const sci = s.activeRealm === 'atom' || s.activeRealm === 'cosmos';
      if (sci && (cmd.weather || cmd.time_of_day || cmd.fog !== undefined)) {
        result = fail(cmd.op, s.activeRealm === 'atom'
          ? 'Weather and daylight have no meaning inside a single atom — there is no air at this scale. You can still change the background colour, or try this in the Nexus or Emberfall.'
          : 'Space is a vacuum: no weather, fog or daylight cycle. You can tint the sky colour, or try this in the Nexus or Emberfall.');
        if (!cmd.sky_color) break;
      }
      const e = s.env[s.activeRealm];
      if (sci) {
        e.skyColor = cmd.sky_color;
        result = { ok: true, op: cmd.op, message: `The background shifts to ${cmd.sky_color} (a visual tint only).` };
        break;
      }
      if (cmd.sky_color) e.skyColor = cmd.sky_color;
      if (cmd.weather) e.weather = cmd.weather;
      if (cmd.time_of_day) { e.timeOfDay = cmd.time_of_day; if (s.activeRealm === 'village') s.story.timeOfDay = cmd.time_of_day; }
      if (cmd.fog !== undefined) e.fog = cmd.fog;
      const parts = [cmd.sky_color && `sky ${cmd.sky_color}`, cmd.weather, cmd.time_of_day, cmd.fog !== undefined && `fog ${cmd.fog}`].filter(Boolean);
      result = { ok: true, op: cmd.op, message: `The environment shifts: ${parts.join(', ') || 'no change'}.` };
      break;
    }
    case 'set_gravity': {
      if (s.activeRealm === 'atom') {
        result = fail(cmd.op, 'Inside the atom, gravity between the proton and electron is ~10³⁹ times weaker than the electric force — changing it would have no visible effect, so ANANT does not pretend it does.');
        break;
      }
      s.env[s.activeRealm].gravity = cmd.multiplier;
      const where = s.activeRealm === 'cosmos' ? `G is now ${cmd.multiplier}× its real value (${(G_AU * cmd.multiplier).toFixed(2)} AU³/M☉·yr²)` : `gravity is now ${cmd.multiplier}× normal`;
      result = { ok: true, op: cmd.op, message: `In ${realmTitle(s.activeRealm)}, ${where}.`, data: { multiplier: cmd.multiplier } };
      break;
    }
    case 'set_time': {
      if (cmd.frozen !== undefined) s.time.frozen = cmd.frozen;
      if (cmd.scale !== undefined) s.time.scale = cmd.scale;
      result = { ok: true, op: cmd.op, message: s.time.frozen ? 'Time stands still.' : `Time flows at ${s.time.scale}×.` };
      break;
    }
    case 'atom_set_orbital': {
      s.atom.n = cmd.n; s.atom.l = cmd.l; s.atom.m = cmd.m;
      s.atom.transition = undefined;
      const rmp = mostProbableRadius(cmd.n, cmd.l);
      result = { ok: true, op: cmd.op, message: `Showing the ${orbitalName(cmd.n, cmd.l, cmd.m)} orbital (n=${cmd.n}, l=${cmd.l}, m=${cmd.m}). Most probable radius: ${rmp.toFixed(2)} a₀.`, data: { n: cmd.n, l: cmd.l, m: cmd.m } };
      break;
    }
    case 'atom_transition': {
      const from: [number, number, number] = [s.atom.n, s.atom.l, s.atom.m];
      if (from[0] === cmd.n && from[1] === cmd.l && from[2] === cmd.m) { result = fail(cmd.op, 'The electron is already in that state.'); break; }
      const d = describeTransition({ n: from[0], l: from[1] }, { n: cmd.n, l: cmd.l });
      s.atom.n = cmd.n; s.atom.l = cmd.l; s.atom.m = cmd.m;
      s.atom.transition = { id: ++s.seq, from, to: [cmd.n, cmd.l, cmd.m], lambda: d.lambda, kind: d.kind, dE: d.dE };
      const photon = d.kind === 'none'
        ? 'Same energy level — no photon (degenerate states in the non-relativistic model).'
        : `${d.kind === 'emission' ? 'Emits' : 'Absorbs'} a ${d.lambda.toFixed(1)} nm ${d.band} photon (${d.series} series, ΔE = ${Math.abs(d.dE).toFixed(2)} eV).`;
      const rule = d.dipoleAllowed ? '' : ' Note: Δl ≠ ±1, so this is electric-dipole forbidden and far slower in reality.';
      result = { ok: true, op: cmd.op, message: `${orbitalName(...from)} → ${orbitalName(cmd.n, cmd.l, cmd.m)}. ${photon}${rule}`, data: { ...d } };
      break;
    }
    case 'atom_set_view': {
      if (cmd.scale !== undefined) s.atom.scale = cmd.scale;
      if (cmd.scale_by !== undefined) s.atom.scale = Math.min(300000, Math.max(0.0005, s.atom.scale * cmd.scale_by));
      if (s.activeRealm === 'atom') s.observer = { size: sizeForAtomZoom(s.atom.scale) };
      if (cmd.show_nucleus !== undefined) s.atom.showNucleus = cmd.show_nucleus;
      if (cmd.highlight_most_probable !== undefined) s.atom.highlight = cmd.highlight_most_probable;
      if (cmd.slice !== undefined) s.atom.slice = cmd.slice;
      const extra = cmd.highlight_most_probable ? ` The glowing shell marks r = ${mostProbableRadius(s.atom.n, s.atom.l).toFixed(2)} a₀, where the radial probability peaks.` : '';
      result = { ok: true, op: cmd.op, message: `${describeZoom(s.atom.scale)}${extra}` };
      break;
    }
    case 'cosmos_create_system': {
      s.cosmos.bodies = makePreset(cmd.preset);
      s.cosmos.preset = cmd.preset;
      s.cosmos.epoch += 1;
      s.cosmos.blackHole = false;
      s.cosmos.paused = false;
      result = { ok: true, op: cmd.op, message: `A new ${cmd.preset.replace('_', ' ')} forms: ${s.cosmos.bodies.map((b) => b.name).join(', ')}.`, data: { bodies: s.cosmos.bodies.length } };
      break;
    }
    case 'cosmos_set_body': {
      const b = resolveBody(s, cmd.target);
      if (!b) { result = fail(cmd.op, `There is no body called "${cmd.target}" in this system.`); break; }
      const before = b.mass;
      if (cmd.mass_multiplier !== undefined) b.mass = b.mass * cmd.mass_multiplier;
      if (cmd.color) b.color = cmd.color;
      const jup = b.mass / 9.545e-4, earth = b.mass / 3.003e-6;
      result = {
        ok: true, op: cmd.op,
        message: cmd.mass_multiplier !== undefined
          ? `${b.name}'s mass: ${before.toExponential(2)} → ${b.mass.toExponential(2)} M☉ (${jup >= 0.1 ? jup.toFixed(1) + ' Jupiter' : earth.toFixed(1) + ' Earth'} masses). Watch the orbits respond.`
          : `${b.name} updated.`,
        data: { id: b.id, mass: b.mass },
      };
      break;
    }
    case 'cosmos_add_body': {
      const central = [...s.cosmos.bodies].sort((a, b) => b.mass - a.mass)[0];
      const cx = central?.pos ?? [0, 0, 0], cv = central?.vel ?? [0, 0, 0];
      const M = central?.mass ?? 1;
      const v = Math.sqrt((G_AU * s.env.cosmos.gravity * M) / cmd.distance);
      const ph = (s.seq * 1.7) % (Math.PI * 2);
      const id = cmd.name.toLowerCase().replace(/\s+/g, '_') + (s.cosmos.bodies.some((b) => b.id === cmd.name.toLowerCase()) ? `_${s.seq}` : '');
      const body: BodyDef = {
        id, name: cmd.name, mass: cmd.mass, kind: cmd.mass > 0.05 ? 'star' : 'planet',
        pos: [cx[0] + cmd.distance * Math.cos(ph), cx[1], cx[2] + cmd.distance * Math.sin(ph)],
        vel: [cv[0] - v * Math.sin(ph), cv[1], cv[2] + v * Math.cos(ph)],
        color: cmd.color ?? '#9ad1ff',
        radius: Math.min(1.4, 0.25 + Math.cbrt(cmd.mass / 3e-6) * 0.06),
      };
      s.cosmos.bodies.push(body);
      ++s.seq;
      result = { ok: true, op: cmd.op, message: `${body.name} enters a circular orbit at ${cmd.distance} AU.`, data: { id } };
      break;
    }
    case 'cosmos_remove_body': {
      const b = resolveBody(s, cmd.target);
      if (!b) { result = fail(cmd.op, `There is no body called "${cmd.target}".`); break; }
      s.cosmos.bodies = s.cosmos.bodies.filter((x) => x.id !== b.id);
      result = { ok: true, op: cmd.op, message: `${b.name} is removed from the simulation.`, data: { id: b.id } };
      break;
    }
    case 'cosmos_set_sim': {
      if (cmd.time_scale !== undefined) s.cosmos.timeScale = cmd.time_scale;
      if (cmd.paused !== undefined) s.cosmos.paused = cmd.paused;
      if (cmd.trails !== undefined) s.cosmos.trails = cmd.trails;
      result = { ok: true, op: cmd.op, message: `Simulation: ${s.cosmos.paused ? 'paused' : `${s.cosmos.timeScale} years per second`}${cmd.trails !== undefined ? `, trails ${cmd.trails ? 'on' : 'off'}` : ''}.` };
      break;
    }
    case 'cosmos_black_hole': {
      s.cosmos.blackHole = cmd.show;
      result = { ok: true, op: cmd.op, message: cmd.show ? 'A Schwarzschild black hole fills the sky. Light bends around it.' : 'The black hole fades; the star system returns.' };
      break;
    }
    case 'camera_focus': {
      const o = resolveObject(s, cmd.target);
      const b = !o && s.activeRealm === 'cosmos' ? resolveBody(s, cmd.target) : undefined;
      const n = !o && !b && s.activeRealm === 'village' ? resolveNpc(cmd.target) : undefined;
      const hit = o ? { kind: 'object' as const, id: o.id, name: o.name } : b ? { kind: 'body' as const, id: b.id, name: b.name } : n ? { kind: 'npc' as const, id: n.id, name: n.name } : undefined;
      if (!hit) { result = fail(cmd.op, `I can't find "${cmd.target}" to look at here.`); break; }
      s.focus = { kind: hit.kind, id: hit.id, seq: ++s.seq };
      result = { ok: true, op: cmd.op, message: `Focusing on ${hit.name}.`, data: hit };
      break;
    }
    case 'talk_to': {
      const n = resolveNpc(cmd.npc);
      if (!n) { result = fail(cmd.op, `Nobody called "${cmd.npc}" lives in Emberfall. You can speak with Captain Ilsa, Maera, Doran or Seren.`); break; }
      if (s.activeRealm !== 'village') { result = fail(cmd.op, `${n.name} is in Emberfall. Travel there first.`); break; }
      if (s.story.npcs[n.id]?.arrested) { result = fail(cmd.op, `${n.name} has been taken to the Regent's cells.`); break; }
      s.story.activeConversation = n.id;
      s.focus = { kind: 'npc', id: n.id, seq: ++s.seq };
      result = { ok: true, op: cmd.op, message: `${n.name} turns to face you.`, data: { npc: n.id } };
      break;
    }
    case 'accuse': {
      const n = resolveNpc(cmd.npc);
      if (!n) { result = fail(cmd.op, `Nobody called "${cmd.npc}" lives in Emberfall.`); break; }
      if (s.activeRealm !== 'village') { result = fail(cmd.op, 'Accusations must be made in Emberfall.'); break; }
      if (s.story.outcome) { result = fail(cmd.op, `The accusation has already been made: ${s.story.outcome.summary}`); break; }
      const r = storyAccuse(s.story, n.id);
      s.story = r.story;
      result = { ok: true, op: cmd.op, message: r.message, data: { outcome: s.story.outcome?.kind } };
      break;
    }
    case 'set_scale': {
      const before = s.observer?.size ?? HUMAN;
      let size = cmd.size_m ?? (cmd.preset ? SCALE_PRESETS[cmd.preset as ScalePreset][0] : before);
      if (cmd.factor !== undefined) size *= cmd.factor;
      size = clampSize(size);
      s.observer = { size };
      const from = s.activeRealm;
      const to = routeForSize(size, from);
      if (to !== from) { s.activeRealm = to; s.selectedId = undefined; }
      if (to === 'atom') s.atom.scale = atomZoomForSize(size);
      const verb = size < before ? 'You shrink' : size > before ? 'You grow' : 'You stay';
      result = { ok: true, op: cmd.op, message: `${verb} to ${describeSize(size)}.${to !== from ? ` (Entering ${realmTitle(to)}.)` : ''} Your mass is unchanged — only your apparent size.`, data: { from, to, size } };
      break;
    }
    case 'save_world': {
      if (cmd.name) s.name = cmd.name;
      result = { ok: true, op: cmd.op, message: `Saving "${s.name}"…`, data: { pendingPersist: true } };
      break;
    }
    default: {
      result = fail((cmd as any).op, `Unsupported operation "${(cmd as any).op}".`);
    }
  }

  if (result.ok) {
    s.updatedAt = now;
    log(s, cmd.op, result.message, now);
    return { state: s, result };
  }
  return { state: prev, result };
}

/** Human description of the powers-of-ten zoom level in the atom realm. */
export function describeZoom(scale: number): string {
  if (scale < 0.12) return `Zoomed out ×${(1 / scale).toFixed(0)}: liquid water — hundreds of molecules.`;
  if (scale < 0.6) return `Zoomed out ×${(1 / scale).toFixed(0)}: a single water molecule, H₂O.`;
  if (scale > 20000) return `Zoomed in ×${scale.toExponential(1)}: the proton at its true size.`;
  if (scale > 40) return `Zoomed in ×${scale.toFixed(0)}: deep inside the atom — almost entirely empty space.`;
  return `Atom view updated (zoom ×${scale.toPrecision(2)}).`;
}

/** Compact summary given to the AI Director so it can reason about the current world. */
export function summarizeWorld(s: WorldState) {
  return {
    activeRealm: s.activeRealm,
    realmTitle: REALM_INFO[s.activeRealm].title,
    mode: REALM_INFO[s.activeRealm].mode,
    objectsHere: s.objects.filter((o) => o.realm === s.activeRealm).map((o) => ({ id: o.id, kind: o.kind, name: o.name, scale: +o.scale.toFixed(2), position: o.position.map((v) => +v.toFixed(1)) })),
    selected: s.selectedId,
    portalsHere: s.portals.filter((p) => p.from === s.activeRealm).map((p) => ({ id: p.id, to: p.to })),
    environment: s.env[s.activeRealm],
    time: s.time,
    atom: { n: s.atom.n, l: s.atom.l, m: s.atom.m, orbital: orbitalName(s.atom.n, s.atom.l, s.atom.m), scale: s.atom.scale },
    cosmos: s.activeRealm === 'cosmos' ? { preset: s.cosmos.preset, bodies: s.cosmos.bodies.map((b) => `${b.name}(${b.mass.toExponential(2)} M☉)`), timeScale: s.cosmos.timeScale, paused: s.cosmos.paused, blackHole: s.cosmos.blackHole } : undefined,
    village: s.activeRealm === 'village' ? { npcs: ['Captain Ilsa (watch captain)', 'Maera (innkeeper)', 'Doran (blacksmith)', 'Seren (herbalist)'], talkingTo: s.story.activeConversation, outcome: s.story.outcome?.kind } : undefined,
    observerSize: describeSize(s.observer?.size ?? HUMAN),
    recent: s.history.slice(-5).map((h) => h.summary),
  };
}
