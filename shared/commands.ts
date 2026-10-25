/**
 * ANANT command registry.
 *
 * Every change to a world goes through one of these structured commands. The AI
 * Director (LLM or local parser) can only *propose* commands; they are validated
 * here and executed by the deterministic reducer in worldState.ts. Nothing an LLM
 * says is ever run as code.
 */
import { z } from 'zod';
import { SCALE_PRESET_IDS, MIN_SIZE, MAX_SIZE } from './scale.js';

export const REALMS = ['nexus', 'atom', 'cosmos', 'village', 'heavy'] as const;
export type RealmId = (typeof REALMS)[number];

export const REALM_INFO: Record<RealmId, { title: string; mode: 'scientific' | 'imaginative' | 'hub' | 'hypothetical'; blurb: string }> = {
  nexus: { title: 'The Nexus', mode: 'hub', blurb: 'The threshold between realities.' },
  atom: { title: 'Inside the Hydrogen Atom', mode: 'scientific', blurb: 'Electron probability density from the Schrödinger equation.' },
  cosmos: { title: 'The Cosmos', mode: 'scientific', blurb: 'A live N-body gravitational simulation.' },
  village: { title: 'Emberfall', mode: 'imaginative', blurb: 'A dark-fantasy village with a stolen crown and living people.' },
  heavy: { title: 'Heavy-Gravity Universe', mode: 'hypothetical', blurb: 'A hypothetical universe where G is 4× ours; the solar system recomputed under that law.' },
};

/** Procedurally generated object kinds the engine can actually build. */
export const OBJECT_KINDS = [
  'castle', 'floating_island', 'sword', 'crystal', 'tree', 'tower', 'orb', 'dragon', 'monolith', 'lantern', 'statue', 'bridge',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const PLACEMENTS = ['in_front', 'above', 'sky', 'ground', 'left', 'right', 'behind', 'center'] as const;
export const WEATHER = ['clear', 'storm', 'rain', 'snow', 'aurora'] as const;
export const TIME_OF_DAY = ['dawn', 'day', 'dusk', 'night'] as const;
export const COSMOS_PRESETS = ['solar_system', 'inner_planets', 'binary_star', 'empty'] as const;

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb');
const target = z.string().min(1).max(64);

export const CommandSchemas = {
  go_to_realm: z.object({ op: z.literal('go_to_realm'), realm: z.enum(REALMS) }),
  open_portal: z.object({
    op: z.literal('open_portal'),
    to: z.enum(REALMS),
    position: vec3.optional(),
  }),
  enter_portal: z.object({ op: z.literal('enter_portal'), portal: target.optional() }),
  close_portal: z.object({ op: z.literal('close_portal'), portal: target }),

  spawn_object: z.object({
    op: z.literal('spawn_object'),
    kind: z.enum(OBJECT_KINDS),
    name: z.string().min(1).max(48).optional(),
    placement: z.enum(PLACEMENTS).optional(),
    position: vec3.optional(),
    scale: z.number().min(0.05).max(50).optional(),
    color: color.optional(),
    glow: z.boolean().optional(),
    floating: z.boolean().optional(),
  }),
  transform_object: z.object({
    op: z.literal('transform_object'),
    target,
    scale_by: z.number().min(0.05).max(20).optional(),
    scale_to: z.number().min(0.05).max(50).optional(),
    move_by: vec3.optional(),
    move_to: vec3.optional(),
    rotate_by: vec3.optional(),
    /** place the target on top of another object */
    place_on: target.optional(),
  }),
  set_object_property: z.object({
    op: z.literal('set_object_property'),
    target,
    color: color.optional(),
    glow: z.boolean().optional(),
    floating: z.boolean().optional(),
    name: z.string().min(1).max(48).optional(),
  }),
  delete_object: z.object({ op: z.literal('delete_object'), target }),
  select_object: z.object({ op: z.literal('select_object'), target }),

  set_environment: z.object({
    op: z.literal('set_environment'),
    sky_color: color.optional(),
    weather: z.enum(WEATHER).optional(),
    time_of_day: z.enum(TIME_OF_DAY).optional(),
    fog: z.number().min(0).max(1).optional(),
  }),
  set_gravity: z.object({ op: z.literal('set_gravity'), multiplier: z.number().min(0).max(10) }),
  set_time: z.object({
    op: z.literal('set_time'),
    frozen: z.boolean().optional(),
    scale: z.number().min(0).max(100).optional(),
  }),

  atom_set_orbital: z.object({
    op: z.literal('atom_set_orbital'),
    n: z.number().int().min(1).max(4),
    l: z.number().int().min(0).max(3),
    m: z.number().int().min(-3).max(3),
  }),
  atom_transition: z.object({
    op: z.literal('atom_transition'),
    n: z.number().int().min(1).max(4),
    l: z.number().int().min(0).max(3),
    m: z.number().int().min(-3).max(3),
  }),
  atom_set_view: z.object({
    op: z.literal('atom_set_view'),
    // powers-of-ten zoom: liquid water (~10⁻⁸ m) down to the proton (~10⁻¹⁵ m)
    scale: z.number().min(0.0005).max(300000).optional(),
    scale_by: z.number().min(0.001).max(1000).optional(),
    show_nucleus: z.boolean().optional(),
    /** temperature of the liquid in the micro-world (kelvin) */
    temperature: z.number().min(1).max(2000).optional(),
    highlight_most_probable: z.boolean().optional(),
    slice: z.boolean().optional(),
  }),

  cosmos_create_system: z.object({ op: z.literal('cosmos_create_system'), preset: z.enum(COSMOS_PRESETS) }),
  cosmos_set_body: z.object({
    op: z.literal('cosmos_set_body'),
    target,
    mass_multiplier: z.number().min(0.001).max(10000).optional(),
    /** drawn size only (sandbox visual) — never changes mass */
    radius_multiplier: z.number().min(0.1).max(20).optional(),
    color: color.optional(),
  }),
  cosmos_add_body: z.object({
    op: z.literal('cosmos_add_body'),
    name: z.string().min(1).max(32),
    /** solar masses */
    mass: z.number().min(1e-12).max(100),
    /** semi-major axis in AU */
    distance: z.number().min(0.05).max(60),
    color: color.optional(),
  }),
  cosmos_remove_body: z.object({ op: z.literal('cosmos_remove_body'), target }),
  cosmos_set_sim: z.object({
    op: z.literal('cosmos_set_sim'),
    time_scale: z.number().min(0).max(50).optional(),
    paused: z.boolean().optional(),
    trails: z.boolean().optional(),
  }),
  cosmos_black_hole: z.object({ op: z.literal('cosmos_black_hole'), show: z.boolean() }),
  cosmos_set_mode: z.object({ op: z.literal('cosmos_set_mode'), mode: z.enum(['sandbox', 'physics']) }),
  cosmos_move_body: z.object({
    op: z.literal('cosmos_move_body'),
    target,
    /** new position in AU (heliocentric frame of the simulation) */
    position: vec3.optional(),
    /** move toward another body by this fraction of the separation */
    toward: target.optional(),
    fraction: z.number().min(0.05).max(0.95).optional(),
    /** put on a circular orbit at this distance (AU) from the heaviest body */
    orbit_au: z.number().min(0.05).max(100).optional(),
  }),
  cosmos_grab: z.object({ op: z.literal('cosmos_grab'), target: target.optional(), release: z.boolean().optional() }),
  reset_system: z.object({ op: z.literal('reset_system') }),
  undo: z.object({ op: z.literal('undo') }),
  redo: z.object({ op: z.literal('redo') }),

  camera_focus: z.object({ op: z.literal('camera_focus'), target }),
  talk_to: z.object({ op: z.literal('talk_to'), npc: target }),
  accuse: z.object({ op: z.literal('accuse'), npc: target }),
  save_world: z.object({ op: z.literal('save_world'), name: z.string().min(1).max(48).optional() }),
  go_to_object: z.object({ op: z.literal('go_to_object'), name: z.string().min(1).max(80) }),
  find_objects: z.object({ op: z.literal('find_objects'), query: z.string().max(80).optional(), jwst: z.boolean().optional() }),
  set_scale: z.object({
    op: z.literal('set_scale'),
    /** apparent body size in metres (NOT mass) */
    size_m: z.number().min(MIN_SIZE).max(MAX_SIZE).optional(),
    preset: z.enum(SCALE_PRESET_IDS as [string, ...string[]]).optional(),
    factor: z.number().min(1e-9).max(1e9).optional(),
  }),
} as const;

export type CommandOp = keyof typeof CommandSchemas;
export const COMMAND_OPS = Object.keys(CommandSchemas) as CommandOp[];

export const CommandSchema = z.discriminatedUnion('op', Object.values(CommandSchemas) as any);
export type Command = { [K in CommandOp]: z.infer<(typeof CommandSchemas)[K]> }[CommandOp];
export type CommandOf<K extends CommandOp> = z.infer<(typeof CommandSchemas)[K]>;

/** Human/LLM-facing documentation for each op — also used to build the Director prompt. */
export const COMMAND_DOCS: Record<CommandOp, string> = {
  go_to_realm: 'Travel directly to a realm (nexus|atom|cosmos|village) with a cinematic transition.',
  open_portal: 'Open a glowing portal in the current realm that shows a live view of another realm. {to, position?}',
  enter_portal: 'Step through a portal (default: the most recently opened one). {portal?}',
  close_portal: 'Close a portal by id. {portal}',
  spawn_object: `Create a procedurally generated object. kind ∈ ${OBJECT_KINDS.join('|')}. {kind, name?, placement? (${PLACEMENTS.join('|')}), position?, scale?, color? #rrggbb, glow?, floating?}`,
  transform_object: 'Move/scale/rotate an object. target = object id, name, kind, or "selected"/"last". {target, scale_by?, scale_to?, move_by?, move_to?, rotate_by? (radians), place_on? (another object to stand it on)}',
  set_object_property: 'Change an object\'s color/glow/floating/name. {target, ...}',
  delete_object: 'Remove an object. {target}',
  select_object: 'Select an object for gesture manipulation. {target}',
  set_environment: `Change the current realm\'s sky/weather/time. {sky_color?, weather? (${WEATHER.join('|')}), time_of_day? (${TIME_OF_DAY.join('|')}), fog? 0..1}`,
  set_gravity: 'Multiply gravity in the current realm (0 = weightless, 1 = normal). In cosmos this scales G. {multiplier}',
  set_time: 'Freeze/unfreeze time or change the global time scale. {frozen?, scale?}',
  atom_set_orbital: 'Show hydrogen orbital (n,l,m). Constraints: 1≤n≤4, 0≤l<n, |m|≤l. 1s=(1,0,0), 2s=(2,0,0), 2p=(2,1,0), 3d=(3,2,0).',
  atom_transition: 'Animate an electron transition to (n,l,m) and emit/absorb a photon with the correct Rydberg wavelength. Same constraints as atom_set_orbital.',
  atom_set_view: 'Adjust atom view / powers-of-ten zoom. scale 1 = one atom; 0.35 ≈ a water molecule; 0.06 ≈ liquid water; 150000 ≈ the proton at true size. {scale? 0.0005..300000, scale_by?, temperature? K (liquid water motion), show_nucleus?, highlight_most_probable? (shell where the electron is most likely to be found), slice? (cut-away)}',
  cosmos_create_system: `Create a star system. preset ∈ ${COSMOS_PRESETS.join('|')}.`,
  cosmos_set_body: 'Change a celestial body. {target (name e.g. "jupiter"), mass_multiplier?, radius_multiplier? (drawn size only), color?}',
  cosmos_set_mode: 'Manipulation mode. sandbox = move/resize freely (moved planets get a fresh circular orbit; moving a star carries its system); physics = moves change only positions and the N-body simulation computes the consequences. {mode}',
  cosmos_move_body: 'Move a celestial body. {target, position? AU, toward? other body + fraction?, orbit_au? (circular orbit at this distance)}',
  cosmos_grab: 'Pick up a celestial body so it follows the pointer/hand; release:true drops it. {target?, release?}',
  reset_system: 'Reset the star system to its initial configuration.',
  undo: 'Undo the last world change.',
  redo: 'Redo the last undone change.',
  cosmos_add_body: 'Add a planet on a circular orbit. {name, mass (solar masses; Earth≈3e-6, Jupiter≈9.5e-4), distance (AU), color?}',
  cosmos_remove_body: 'Remove a celestial body. {target}',
  cosmos_set_sim: 'Simulation controls. {time_scale? (years per second, 0..50), paused?, trails?}',
  cosmos_black_hole: 'Show/hide the Schwarzschild black-hole view. {show}',
  camera_focus: 'Point the camera at an object, body, or NPC. {target}',
  talk_to: 'Begin a conversation with an NPC in the village. {npc}',
  accuse: 'Formally accuse an NPC of stealing the Ember Crown (story decision with consequences). {npc}',
  save_world: 'Save the current world. {name?}',
  go_to_object: 'Fly to a real catalogued astronomical object (e.g. Andromeda, Sombrero Galaxy, Pillars of Creation, Orion Nebula, Sagittarius A*, Stephan’s Quintet, M87). {name}',
  find_objects: 'Search the astronomical catalog. {query?, jwst? (only objects imaged by the James Webb Space Telescope)}',
  set_scale: `Change the user's APPARENT size (never their mass). Moves to the realm that can show that size (< 1 µm → atom/micro world, > 2 km → cosmos, otherwise human scale). {size_m? metres, preset? (${SCALE_PRESET_IDS.join('|')}), factor? (e.g. 0.1 = ten times smaller)}`,
};

export interface ValidationIssue {
  index: number;
  op?: string;
  error: string;
}

/** Validate an untrusted list of commands. Returns valid ones and per-item errors. */
export function validateCommands(raw: unknown): { valid: Command[]; issues: ValidationIssue[] } {
  const valid: Command[] = [];
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(raw)) return { valid, issues: [{ index: -1, error: 'commands must be an array' }] };
  raw.slice(0, 12).forEach((item, index) => {
    const op = item && typeof item === 'object' ? (item as any).op : undefined;
    if (!op || !(op in CommandSchemas)) {
      issues.push({ index, op, error: `unknown op "${String(op)}"` });
      return;
    }
    const parsed = (CommandSchemas as any)[op].safeParse(item);
    if (!parsed.success) {
      issues.push({ index, op, error: parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const semantic = semanticCheck(parsed.data as Command);
    if (semantic) {
      issues.push({ index, op, error: semantic });
      return;
    }
    valid.push(parsed.data as Command);
  });
  if (raw.length > 12) issues.push({ index: 12, error: 'too many commands (max 12)' });
  return { valid, issues };
}

/** Physics/logic constraints that a schema alone cannot express. */
export function semanticCheck(cmd: Command): string | null {
  if (cmd.op === 'atom_set_orbital' || cmd.op === 'atom_transition') {
    if (cmd.l >= cmd.n) return `quantum numbers invalid: l (${cmd.l}) must be < n (${cmd.n})`;
    if (Math.abs(cmd.m) > cmd.l) return `quantum numbers invalid: |m| (${Math.abs(cmd.m)}) must be ≤ l (${cmd.l})`;
  }
  if (cmd.op === 'set_scale' && cmd.size_m === undefined && cmd.preset === undefined && cmd.factor === undefined) return 'set_scale needs size_m, preset or factor';
  if (cmd.op === 'cosmos_move_body' && !cmd.position && !cmd.toward && cmd.orbit_au === undefined) return 'cosmos_move_body needs position, toward or orbit_au';
  if (cmd.op === 'transform_object') {
    const any = cmd.scale_by ?? cmd.scale_to ?? cmd.move_by ?? cmd.move_to ?? cmd.rotate_by ?? cmd.place_on;
    if (any === undefined) return 'transform_object needs at least one of scale_by, scale_to, move_by, move_to, rotate_by, place_on';
  }
  return null;
}

/** Shape the Director (LLM or local) must return. */
export const DirectorReplySchema = z.object({
  narration: z.string().max(1200).default(''),
  commands: z.array(z.unknown()).default([]),
  unsupported: z
    .array(z.object({ request: z.string().max(300), reason: z.string().max(400), suggestion: z.string().max(400).optional() }))
    .default([]),
});
export type DirectorReply = {
  narration: string;
  commands: Command[];
  unsupported: { request: string; reason: string; suggestion?: string }[];
  issues: ValidationIssue[];
  source: 'nemotron' | 'local-parser';
  model?: string;
  latencyMs?: number;
  fallbackReason?: string;
};

export const ORBITAL_LETTERS = ['s', 'p', 'd', 'f'];
export function orbitalName(n: number, l: number, m: number): string {
  const realNames: Record<string, string> = {
    '1,0': 'p_z', '1,1': 'p_x', '1,-1': 'p_y',
    '2,0': 'd_z²', '2,1': 'd_xz', '2,-1': 'd_yz', '2,2': 'd_x²−y²', '2,-2': 'd_xy',
    '3,0': 'f_z³', '3,1': 'f_xz²', '3,-1': 'f_yz²', '3,2': 'f_z(x²−y²)', '3,-2': 'f_xyz', '3,3': 'f_x(x²−3y²)', '3,-3': 'f_y(3x²−y²)',
  };
  if (l === 0) return `${n}s`;
  return `${n}${realNames[`${l},${m}`] ?? ORBITAL_LETTERS[l]}`;
}
