/**
 * Deterministic, rule-based intent parser.
 *
 * This is the OFFLINE FALLBACK for the AI Director. It is used when no Nebius
 * credentials are configured or the model call fails, and every reply it makes
 * is labelled `source: "local-parser"` in the UI. It covers the demo's command
 * vocabulary with flexible phrasing, but it is pattern matching — not an LLM —
 * and it says so.
 */
import type { Command, RealmId, ObjectKind } from './commands.js';
import { validateCommands } from './commands.js';
import type { WorldState } from './worldState.js';
import { resolveObject, resolveBody } from './worldState.js';
import { resolveNpc } from './story.js';
import { resolveAstro } from './astro.js';

export interface ParseOutput {
  narration: string;
  commands: Command[];
  unsupported: { request: string; reason: string; suggestion?: string }[];
}

export const COLORS: Record<string, string> = {
  red: '#e0383e', crimson: '#b0122b', scarlet: '#ff2400', orange: '#ff8a2b', amber: '#ffb000', gold: '#ffc94a', golden: '#ffc94a',
  yellow: '#ffe14d', green: '#3ccf6e', emerald: '#18a558', teal: '#1fb5a8', cyan: '#3fe0ff', turquoise: '#3fe0d0', blue: '#3a7bff',
  azure: '#3fa9ff', sapphire: '#2348c9', indigo: '#4b3fd1', purple: '#8e44ff', violet: '#9b5cff', lavender: '#c3a6ff', magenta: '#ff3fd2',
  pink: '#ff7ab8', rose: '#ff5c8a', white: '#f4f4ff', black: '#101015', obsidian: '#16121c', silver: '#c8ccd8', grey: '#8a8d96', gray: '#8a8d96',
  blood: '#8a0303', emerald_green: '#18a558',
};

const KIND_WORDS: [RegExp, ObjectKind][] = [
  [/floating\s+island|sky\s*island|\bisland\b/, 'floating_island'],
  [/\bcastle|fortress|citadel|palace\b/, 'castle'],
  [/\bsword|blade|katana|sabre|saber\b/, 'sword'],
  [/\bcrystal|gem|jewel|shard\b/, 'crystal'],
  [/\btree|oak|pine|willow\b/, 'tree'],
  [/\btower|spire|lighthouse\b/, 'tower'],
  [/\bdragon|wyvern|wyrm\b/, 'dragon'],
  [/\bmonolith|obelisk|pillar|column\b/, 'monolith'],
  [/\blantern|lamp|torch\b/, 'lantern'],
  [/\bstatue|sculpture|idol\b/, 'statue'],
  [/\bbridge\b/, 'bridge'],
  [/\borb|sphere|\bball\b|star\s*seed|wisp\b/, 'orb'],
];

const REALM_WORDS: [RegExp, RealmId][] = [
  [/\b(heavy[- ]gravity|multiverse|(another|alternate|alternative|parallel|hypothetical|different|other) universe|universe (with|where) (stronger|heavier|more) gravity|stronger gravity universe)\b/, 'heavy'],
  [/\b(village|kingdom|fantasy|emberfall|medieval|story|realm of magic|magic(al)? (world|land)|tavern|castle town)\b/, 'village'],
  [/\b(atom|atomic|hydrogen|electron|quantum|orbital|nucleus|subatomic)\b/, 'atom'],
  [/\b(our (own |real )?universe|real universe|home universe)\b/, 'cosmos'],
  [/\b(space|universe|cosmos|cosmic|solar system|planets?|stars?|galaxy|black hole|orbit|astronom\w*)\b/, 'cosmos'],
  [/\b(nexus|home|hub|beginning|start|lobby|void)\b/, 'nexus'],
];

const NEXT_IN_JOURNEY: Record<RealmId, RealmId> = { nexus: 'atom', atom: 'cosmos', cosmos: 'village', village: 'nexus', heavy: 'cosmos' };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, hundred: 100, thousand: 1000, twice: 2, double: 2, triple: 3, thrice: 3, quadruple: 4, half: 0.5 };

function realmFrom(text: string): RealmId | undefined {
  for (const [re, r] of REALM_WORDS) if (re.test(text)) return r;
  return undefined;
}

function colorFrom(text: string): string | undefined {
  const hex = text.match(/#[0-9a-f]{6}\b/i);
  if (hex) return hex[0].toLowerCase();
  for (const [w, c] of Object.entries(COLORS)) if (new RegExp(`\\b${w}\\b`).test(text)) return c;
  return undefined;
}

function multiplierFrom(text: string, dflt: number): number {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(x|×|times)/);
  if (m) return parseFloat(m[1]);
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return 1 + parseFloat(pct[1]) / 100;
  for (const [w, v] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(text)) {
    if (/times|as/.test(text) || ['twice', 'double', 'triple', 'thrice', 'quadruple', 'half'].includes(w)) return v;
  }
  return dflt;
}

const ORBITAL_SUB: Record<string, [number, number]> = {
  // sub-label -> [l, m] in the real-orbital basis
  pz: [1, 0], px: [1, 1], py: [1, -1],
  dz2: [2, 0], 'dz²': [2, 0], dxz: [2, 1], dyz: [2, -1], 'dx2-y2': [2, 2], 'dx²-y²': [2, 2], dxy: [2, -2],
};

function orbitalFrom(text: string): { n: number; l: number; m: number } | undefined {
  const t = text.replace(/[\s_]+(?=[xyz])/g, '');
  const m = t.match(/\b([1-4])\s*([spdf])((?:x2-y2|x²-y²|z2|z²|xy|xz|yz|x|y|z)?)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const l = 'spdf'.indexOf(m[2]);
    const sub = m[3] ? `${m[2]}${m[3]}` : '';
    const lm = ORBITAL_SUB[sub];
    return { n, l, m: lm && lm[0] === l ? lm[1] : 0 };
  }
  if (/ground state/.test(text)) return { n: 1, l: 0, m: 0 };
  const q = text.match(/n\s*=\s*([1-4])(?:.*?l\s*=\s*([0-3]))?(?:.*?m\s*=\s*(-?[0-3]))?/);
  if (q) return { n: +q[1], l: q[2] ? +q[2] : 0, m: q[3] ? +q[3] : 0 };
  return undefined;
}

function ordinalPlanet(text: string, s: WorldState): string | undefined {
  const ords = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
  const m = text.match(new RegExp(`\\b(${ords.join('|')}|\\d)(?:st|nd|rd|th)?\\s+planet`));
  if (!m) return undefined;
  const idx = ords.includes(m[1]) ? ords.indexOf(m[1]) : parseInt(m[1], 10) - 1;
  const star = s.cosmos.bodies.find((b) => b.kind === 'star');
  const planets = s.cosmos.bodies
    .filter((b) => b.kind !== 'star')
    .map((b) => ({ b, d: Math.hypot(b.pos[0] - (star?.pos[0] ?? 0), b.pos[2] - (star?.pos[2] ?? 0)) }))
    .sort((a, c) => a.d - c.d);
  return planets[idx]?.b.id;
}

const PLANET_NAMES = /\b(sun|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|star a|star b|tatooine)(?:s)?\b/;
const MOONS = /\b(europa|io|ganymede|callisto|titan|enceladus|moon|phobos|deimos|triton)\b/;

function splitClauses(text: string): string[] {
  return text
    .split(/\s*(?:[.;!?]+\s+|,?\s+and then\s+|,?\s+then\s+|,\s*and\s+(?=(?:make|create|open|show|take|go|switch|increase|add|put|summon|let|move|rotate|turn|change|slow|speed|freeze|enter|talk|set)\b)|\s+and\s+(?=(?:make|create|open|show|take|go|switch|increase|add|put|summon|let|move|rotate|turn|change|slow|speed|freeze|enter|talk|set)\b))/)
    .map((c) => c.trim())
    .filter(Boolean);
}

export function parseIntent(input: string, world: WorldState): ParseOutput {
  const out: ParseOutput = { narration: '', commands: [], unsupported: [] };
  // Simulate realm changes across clauses so "go to the village and talk to Maera" works.
  let realm = world.activeRealm;
  const sim: WorldState = { ...world };
  const push = (c: any) => {
    out.commands.push(c);
    if (c.op === 'go_to_realm') realm = c.realm;
    if (c.op === 'enter_portal') {
      const p = [...world.portals].reverse().find((x) => x.from === realm);
      if (p) realm = p.to;
    }
    sim.activeRealm = realm;
  };
  const ensureRealm = (r: RealmId) => { if (realm !== r) push({ op: 'go_to_realm', realm: r }); };

  for (const raw of splitClauses(input)) {
    const t = ' ' + raw.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim() + ' ';
    const before = out.commands.length + out.unsupported.length;

    // ——— unsupported-but-recognised requests (be honest, offer an alternative) ———
    if (/(years ago|in the past|what happened here|history of this|go back in time|centuries ago)/.test(t)) {
      out.unsupported.push({ request: raw, reason: 'Historical reconstruction of a location is a research goal; ANANT has no time-indexed world history for these realms yet.', suggestion: realm === 'village' ? 'Ask an Emberfall villager what happened last night — they remember.' : 'Try "freeze time" or "slow down the simulation".' });
      continue;
    }
    if (/(perspective|through (his|her|their) eyes|as (another|a different) character|play as)/.test(t)) {
      out.unsupported.push({ request: raw, reason: 'Switching the player into another character is not implemented in this prototype.', suggestion: 'You can talk to any villager and they will tell the story from their point of view.' });
      continue;
    }

    // ——— portals ———
    if (/\bportal|gateway|rift|wormhole\b/.test(t)) {
      if (/(close|shut|collapse|destroy|remove)/.test(t)) {
        const p = [...world.portals].reverse().find((x) => x.from === realm);
        if (p) push({ op: 'close_portal', portal: p.id });
        else out.unsupported.push({ request: raw, reason: 'There is no portal here to close.' });
        continue;
      }
      if (/(enter|step|walk|go|jump|move|pass)\s+(in)?(to|through|inside)?/.test(t) && !/(open|create|make|summon|draw|conjure)/.test(t)) {
        push({ op: 'enter_portal' });
        continue;
      }
      const dest = realmFrom(t.replace(/\bportal\b/g, '')) ?? NEXT_IN_JOURNEY[realm];
      if (dest === realm) {
        out.unsupported.push({ request: raw, reason: `You are already in that realm.`, suggestion: `Open a portal to ${NEXT_IN_JOURNEY[realm]}.` });
        continue;
      }
      push({ op: 'open_portal', to: dest });
      if (/(and (go|step|walk) (in|through)|take me through)/.test(t)) push({ op: 'enter_portal' });
      continue;
    }

    // ——— atom: orbitals, transitions, view ———
    const orb = orbitalFrom(t);
    if (orb) {
      if (orb.l >= orb.n || Math.abs(orb.m) > orb.l) {
        out.unsupported.push({ request: raw, reason: `${orb.n}${'spdf'[orb.l]} does not exist: the angular quantum number l must be less than n.`, suggestion: orb.n === 1 ? 'Try 1s or 2p.' : `Try ${orb.n}${'spdf'[orb.n - 1]}.` });
        continue;
      }
      ensureRealm('atom');
      const isTransition = /(excite|jump|transition|drop|decay|fall|emit|absorb|move the electron|promote|relax)/.test(t);
      push({ op: isTransition ? 'atom_transition' : 'atom_set_orbital', ...orb });
      continue;
    }
    // ——— celestial manipulation, undo/redo ———
    if (/^ ?(undo|undo (that|it|what i (just )?did)|go back|revert( that)?)\b/.test(t)) { push({ op: 'undo' }); continue; }
    if (/^ ?redo\b/.test(t)) { push({ op: 'redo' }); continue; }
    if (/reset (the )?(solar |star )?system/.test(t)) { ensureRealm('cosmos'); push({ op: 'reset_system' }); continue; }
    if (/sandbox( mode)?/.test(t)) { ensureRealm('cosmos'); push({ op: 'cosmos_set_mode', mode: 'sandbox' }); continue; }
    if (/physics mode/.test(t)) { ensureRealm('cosmos'); push({ op: 'cosmos_set_mode', mode: 'physics' }); continue; }
    if (/(let go|drop it|release (it|the)|put it down)/.test(t)) { push({ op: 'cosmos_grab', release: true }); continue; }
    const grab = t.match(/(?:grab|pick up|hold|let me (?:grab|hold|take)|take hold of|catch)\s+(?:the\s+)?(sun|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|star a|star b)\b/);
    if (grab && !/(large|big|tall) enough|make me|in my hands?/.test(t)) { ensureRealm('cosmos'); push({ op: 'cosmos_grab', target: grab[1] }); continue; }
    const moveT = t.match(/move (?:the\s+)?(\w+) (?:closer to|toward|towards|near) (?:the\s+)?(\w+)/);
    if (moveT && PLANET_NAMES.test(` ${moveT[1]} `)) { ensureRealm('cosmos'); push({ op: 'cosmos_move_body', target: moveT[1], toward: moveT[2], fraction: 0.4 }); continue; }
    const orbitT = t.match(/(?:put|move|place) (?:the\s+)?(\w+) (?:in|into|on) (?:an? )?(?:different |new |wider |circular )?orbit(?: at (\d+(?:\.\d+)?) ?au)?/);
    if (orbitT && PLANET_NAMES.test(` ${orbitT[1]} `)) { ensureRealm('cosmos'); push({ op: 'cosmos_move_body', target: orbitT[1], orbit_au: orbitT[2] ? +orbitT[2] : 2.2 }); continue; }
    const bigger = t.match(/make (?:the\s+)?(sun|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune) (twice|three times|\d+(?:\.\d+)? times|bigger|larger|smaller)( as)? ?(large|big)?/);
    if (bigger && !/mass|massive|heav/.test(t)) { ensureRealm('cosmos'); push({ op: 'cosmos_set_body', target: bigger[1], radius_multiplier: /smaller/.test(bigger[2]) ? 0.5 : multiplierFrom(t, 2) }); continue; }

    // ——— real astronomical objects ———
    if (/(james webb|jwst|webb telescope)/.test(t) && /(show|find|list|galax|object|observ)/.test(t)) { push({ op: 'find_objects', jwst: true }); continue; }
    const astroQ = t.match(/(?:take me to|fly (?:me )?to|go to|show me|find|visit|travel to|navigate to|zoom (?:in )?(?:to|on))\s+(?:the\s+)?(.+?)\s*$/);
    const astro = astroQ ? resolveAstro(astroQ[1]) : undefined;
    if (astro && !/(orbital|electron|portal)/.test(t)) { push({ op: 'go_to_object', name: astro.id }); continue; }

    // ——— universal scale: the user's apparent size ———
    const meters = t.match(/make me (\d+(?:\.\d+)?)\s*(m|meters?|metres?|km|kilometers?)\s*(tall|big|high)?/);
    const scalePreset: string | undefined =
      /(hold the sun|sun in my hands?|large enough to (hold|grab) the sun)/.test(t) ? 'hold_sun'
      : /(solar system (fit|in) (in )?my hands?|(entire|whole) solar system)/.test(t) ? 'solar_system'
      : /(thousands of galaxies|observable universe|cosmic web|zoom out .*galax)/.test(t) ? 'galaxies'
      : /(see|view|show) .*(entire |whole )?milky way|outside (of )?the milky way|zoom out .*milky way/.test(t) ? 'milky_way'
      : /(bigger|larger) than (the )?sun/.test(t) ? 'sun'
      : /(size of|as (large|big) as|bigger than) jupiter/.test(t) ? 'jupiter'
      : /(size of|as (large|big) as) (the )?earth|bigger than (the )?earth/.test(t) ? 'earth'
      : /(human|normal|regular|my) size|back to (my )?(normal|human)/.test(t) ? 'human'
      : /(shrink|make) me .*(molecul)/.test(t) ? 'molecule'
      : /(shrink|make) me .*(individual atoms|see atoms|among (the )?atoms)/.test(t) ? 'atoms'
      : /(shrink|make) me .*(atom|atomic)/.test(t) ? 'atom'
      : /(shrink|make) me .*(cell)/.test(t) ? 'cell'
      : /(shrink|make) me .*(virus)/.test(t) ? 'virus'
      : /(shrink|make) me .*(proton|nucleus)/.test(t) ? 'proton'
      : /(make me|i want to be) (as tall as|the size of) (a )?(building|tower)/.test(t) ? 'building'
      : undefined;
    if (meters) {
      const v = parseFloat(meters[1]) * (/^k/.test(meters[2]) ? 1000 : 1);
      push({ op: 'set_scale', size_m: v });
      continue;
    }
    if (scalePreset) { push({ op: 'set_scale', preset: scalePreset }); continue; }
    if (/^ ?(make me|i want to be) (much |a lot |way )?(smaller|tiny|tinier)|^ ?shrink me/.test(t)) { push({ op: 'set_scale', factor: /(much|a lot|way)/.test(t) ? 0.001 : 0.1 }); continue; }
    if (/^ ?(make me|i want to be) (much |a lot |way )?(bigger|larger|huge|giant|taller)|^ ?grow me/.test(t)) { push({ op: 'set_scale', factor: /(much|a lot|way)/.test(t) ? 1000 : 10 }); continue; }

    // temperature of the liquid in the micro-world
    const kelvin = t.match(/(\d+(?:\.\d+)?)\s*(k|kelvin)\b/);
    const celsius = t.match(/(-?\d+(?:\.\d+)?)\s*(°\s*c|degrees? c(elsius)?|celsius)/);
    const tempTo = kelvin ? +kelvin[1] : celsius ? +celsius[1] + 273.15
      : /(boil)/.test(t) ? 373 : /(heat|hotter|warm(er)? (it|the water)|increase the temperature)/.test(t) && /(water|liquid|it|molecule|temperature)/.test(t) ? 600
      : /(cool|colder|chill|lower the temperature|freeze)/.test(t) && /(water|liquid|it|molecule|temperature)/.test(t) ? 150 : undefined;
    if (tempTo !== undefined && (realm === 'atom' || /water|molecul/.test(t))) {
      ensureRealm('atom');
      push({ op: 'atom_set_view', temperature: Math.min(2000, Math.max(1, +tempTo.toFixed(1))) });
      continue;
    }

    // powers-of-ten zoom around the atom
    const zoomTo = /(liquid water|glass of water|many molecules|sea of molecules)/.test(t) ? 0.06
      : /(water molecule|h2o|molecule|molecular)/.test(t) ? 0.35
      : /(proton|nucleus|quark|femto)/.test(t) && /(inside|into|zoom|show|see|go|take|close)/.test(t) && !/(hide|remove)/.test(t) ? 150000
      : /(back to|whole|single|one) (the )?atom|atomic scale/.test(t) ? 1 : undefined;
    if (zoomTo !== undefined) {
      ensureRealm('atom');
      push({ op: 'atom_set_view', scale: zoomTo });
      continue;
    }
    if (/(most likely|most probable|highest probability|where .*electron .*(found|be))/.test(t)) {
      ensureRealm('atom');
      push({ op: 'atom_set_view', highlight_most_probable: true });
      continue;
    }
    if (realm === 'atom' && /\bnucleus|proton\b/.test(t) && /(hide|remove|show|reveal)/.test(t)) {
      push({ op: 'atom_set_view', show_nucleus: !/(hide|remove)/.test(t) });
      continue;
    }
    if (realm === 'atom' && /(slice|cut ?away|cross.?section|inside of the cloud)/.test(t)) {
      push({ op: 'atom_set_view', slice: !/(remove|no|stop|undo)/.test(t) });
      continue;
    }
    if (realm === 'atom' && /(scale|zoom|bigger|larger|smaller|enlarge|shrink|magnif)/.test(t) && !resolveObjectMention(t, sim)) {
      const down = /(decrease|smaller|shrink|zoom out|reduce|less)/.test(t);
      push({ op: 'atom_set_view', scale_by: down ? 1 / multiplierFrom(t, 1.5) : multiplierFrom(t, 1.5) });
      continue;
    }
    if (/(inside|into|enter)\s+(an?|the)?\s*(atom|hydrogen)|take me .*atom|quantum (world|realm)/.test(t)) {
      ensureRealm('atom');
      continue;
    }

    // ——— cosmos ———
    if (/black hole/.test(t)) {
      ensureRealm('cosmos');
      push({ op: 'cosmos_black_hole', show: !/(hide|remove|close|leave|away|get rid|stop)/.test(t) });
      continue;
    }
    if (/(solar system|star system|binary|planetary system|inner planets)/.test(t) && /(create|make|build|generate|show|form|spawn|give|reset|new)/.test(t)) {
      ensureRealm('cosmos');
      const preset = /binary/.test(t) ? 'binary_star' : /inner/.test(t) ? 'inner_planets' : 'solar_system';
      push({ op: 'cosmos_create_system', preset });
      if (/(miniature|small|tiny|mini)/.test(t)) push({ op: 'cosmos_set_sim', time_scale: 0.6 });
      continue;
    }
    const planetMention = t.match(PLANET_NAMES)?.[1] ?? ordinalPlanet(t, sim);
    if ((realm === 'cosmos' || /mass|massive|heavier|lighter/.test(t)) && planetMention && /(mass|massive|heav|light|weigh)/.test(t)) {
      ensureRealm('cosmos');
      const down = /(lighter|less massive|reduce|decrease|smaller mass|halve)/.test(t);
      const mult = down ? 1 / Math.max(1.01, multiplierFrom(t, 10)) : multiplierFrom(t, /increase|heavier|more massive/.test(t) && !/\d|twice|double|triple|times/.test(t) ? 100 : 2);
      push({ op: 'cosmos_set_body', target: planetMention, mass_multiplier: /half/.test(t) ? 0.5 : mult });
      continue;
    }
    if (/(add|create|make|spawn) (a |an )?(new )?(planet|world|moon)/.test(t)) {
      ensureRealm('cosmos');
      const au = parseFloat(t.match(/(\d+(?:\.\d+)?)\s*au/)?.[1] ?? '2.5');
      const name = t.match(/(?:called|named)\s+([a-z][a-z0-9 -]{1,20}?)(?=\s+(?:at|with|that|which)|\s*$)/)?.[1]?.trim() ?? 'Nova';
      const mass = /(giant|jupiter|huge|massive)/.test(t) ? 9.5e-4 : 3e-6;
      push({ op: 'cosmos_add_body', name: name.replace(/\b\w/g, (c) => c.toUpperCase()), mass, distance: Math.min(60, Math.max(0.1, au)), color: colorFrom(t) });
      continue;
    }
    if (MOONS.test(t) && /(take me|go|travel|fly|show|visit)/.test(t)) {
      const moon = t.match(MOONS)![1];
      const parent = ['europa', 'io', 'ganymede', 'callisto'].includes(moon) ? 'jupiter' : ['titan', 'enceladus'].includes(moon) ? 'saturn' : moon === 'triton' ? 'neptune' : moon === 'moon' ? 'earth' : 'mars';
      ensureRealm('cosmos');
      push({ op: 'camera_focus', target: parent });
      out.unsupported.push({ request: raw, reason: `Moons are not simulated as separate bodies yet, so ${moon[0].toUpperCase() + moon.slice(1)} can't be visited directly.`, suggestion: `Flying to ${parent[0].toUpperCase() + parent.slice(1)}, its parent planet, instead.` });
      continue;
    }
    if ((realm === 'cosmos' || /simulation|orbit/.test(t)) && /(slow|speed|faster|pause|resume|unpause|play|time ?scale|trails?)/.test(t) && !/time stand|freeze/.test(t)) {
      const cur = world.cosmos.timeScale;
      if (/trail/.test(t)) push({ op: 'cosmos_set_sim', trails: !/(hide|remove|off|no)/.test(t) });
      else if (/pause|stop/.test(t)) push({ op: 'cosmos_set_sim', paused: true });
      else if (/(resume|unpause|play|continue)/.test(t)) push({ op: 'cosmos_set_sim', paused: false });
      else if (/slow/.test(t)) push({ op: 'cosmos_set_sim', time_scale: +Math.max(0.02, cur / multiplierFrom(t, 3)).toFixed(3), paused: false });
      else push({ op: 'cosmos_set_sim', time_scale: +Math.min(50, cur * multiplierFrom(t, 3)).toFixed(3), paused: false });
      continue;
    }
    if (planetMention && /(take me|go to|fly|focus|look at|show me|visit|zoom)/.test(t)) {
      ensureRealm('cosmos');
      push({ op: 'camera_focus', target: planetMention });
      continue;
    }

    // ——— time ———
    if (/(freeze|stop) time|time (stand|stop)|pause time/.test(t)) { push({ op: 'set_time', frozen: true }); continue; }
    if (/(unfreeze|resume|restart|start) time|time (flow|move|resume)/.test(t)) { push({ op: 'set_time', frozen: false }); continue; }
    if (/(slow|speed).*(time|everything|world)|time.*(slow|fast)/.test(t)) {
      push({ op: 'set_time', scale: /slow/.test(t) ? 0.3 : 3, frozen: false });
      continue;
    }

    // ——— gravity ———
    if (/gravity|weightless/.test(t) && !/universe/.test(t)) {
      let mult = 1;
      if (/(zero|no|turn off|weightless|remove)/.test(t)) mult = 0;
      else if (/(weaker|lower|reduce|less|decrease|moon)/.test(t)) mult = /half/.test(t) ? 0.5 : 0.3;
      else if (/(stronger|higher|increase|more|heavier)/.test(t)) mult = Math.min(10, multiplierFrom(t, 2.5));
      else if (/(normal|reset|restore)/.test(t)) mult = 1;
      else mult = multiplierFrom(t, 1);
      push({ op: 'set_gravity', multiplier: mult });
      continue;
    }

    // ——— environment ———
    if (/\bsky\b/.test(t) && colorFrom(t)) { push({ op: 'set_environment', sky_color: colorFrom(t) }); continue; }
    const weather = /(storm|thunder|lightning|tempest)/.test(t) ? 'storm' : /\b(rain|drizzle)\b/.test(t) ? 'rain' : /\b(snow|blizzard|winter)\b/.test(t) ? 'snow' : /(aurora|northern lights)/.test(t) ? 'aurora' : /(clear (the )?(sky|weather)|stop the (storm|rain|snow)|calm)/.test(t) ? 'clear' : undefined;
    if (weather) { push({ op: 'set_environment', weather }); continue; }
    const tod = /(make it night|nightfall|midnight|night time|\bnight\b)/.test(t) ? 'night' : /(sunrise|dawn|morning)/.test(t) ? 'dawn' : /(sunset|dusk|evening|twilight)/.test(t) ? 'dusk' : /(daytime|noon|make it day|daylight|\bday\b)/.test(t) ? 'day' : undefined;
    if (tod && /(make|set|turn|change|it|bring)/.test(t)) { push({ op: 'set_environment', time_of_day: tod }); continue; }
    if (/\bfog|mist|haze\b/.test(t)) { push({ op: 'set_environment', fog: /(remove|clear|less|no|lift)/.test(t) ? 0.05 : 0.8 }); continue; }

    // ——— story ———
    if (/\bking|queen|regent|valk\b/.test(t) && /(talk|speak|meet|see|ask)/.test(t)) {
      out.unsupported.push({ request: raw, reason: 'Regent Valk rules from the keep and does not receive travellers — he is not a character you can talk to in this prototype.', suggestion: 'Captain Ilsa serves the Regent. Try "talk to Captain Ilsa".' });
      continue;
    }
    const talk = t.match(/(?:talk|speak|chat)\s+(?:to|with)\s+(?:the\s+)?([a-z ]+?)\s*$|(?:approach|greet)\s+(?:the\s+)?([a-z ]+?)\s*$|let me talk to (?:the\s+)?([a-z ]+?)\s*$/);
    if (talk) {
      const who = (talk[1] ?? talk[2] ?? talk[3] ?? '').trim();
      const npc = resolveNpc(who);
      if (!npc) {
        out.unsupported.push({ request: raw, reason: `Nobody called "${who}" lives in Emberfall.`, suggestion: 'You can speak with Captain Ilsa, Maera the innkeeper, Doran the blacksmith or Seren the herbalist.' });
        continue;
      }
      ensureRealm('village');
      push({ op: 'talk_to', npc: npc.id });
      continue;
    }
    const acc = t.match(/(?:accuse|arrest|blame|it was)\s+(?:the\s+)?([a-z ]+?)(?:\s+of.*|\s+did it.*|\s+stole.*)?\s*$/);
    if (acc && resolveNpc(acc[1])) { ensureRealm('village'); push({ op: 'accuse', npc: resolveNpc(acc[1])!.id }); continue; }

    // ——— save ———
    if (/\bsave\b/.test(t)) {
      const name = t.match(/save .* as ([a-z0-9 '-]{1,40})\s*$/)?.[1]?.trim();
      push({ op: 'save_world', ...(name ? { name: name.replace(/\b\w/g, (c) => c.toUpperCase()) } : {}) });
      continue;
    }

    // ——— object creation ———
    const createVerb = /\b(create|make|summon|spawn|build|conjure|add|place|generate|materiali[sz]e|forge|raise|grow|give me|i want|bring forth)\b/.test(t);
    const kind = KIND_WORDS.find(([re]) => re.test(t))?.[1];
    // "put the castle on the floating island"
    const putOn = t.match(/(?:put|place|move|set)\s+(?:the\s+)?([a-z_ ]+?)\s+(?:on|onto|on top of|atop)\s+(?:the\s+)?([a-z_ ]+?)\s*$/);
    if (putOn) {
      const a = resolveObject(sim, putOn[1]);
      const b = resolveObject(sim, putOn[2]);
      const bKind = KIND_WORDS.find(([re]) => re.test(putOn[2]))?.[1];
      if (a && (b || bKind)) {
        if (!b) push({ op: 'spawn_object', kind: bKind!, placement: 'above' });
        push({ op: 'transform_object', target: a.id, place_on: b ? b.id : bKind! });
        continue;
      }
    }
    // "make the castle larger" manipulates the existing castle; "make a castle" creates one.
    const existingRef = resolveObjectMention(t, sim);
    const wantsNew = /\b(a|an|another|new|second|one more|some|\d+)\b/.test(t) || !existingRef;
    if (createVerb && kind && wantsNew) {
      const glow = /(glow|shining|luminous|radiant|light|burning|blazing|magic)/.test(t) || undefined;
      const floating = /(float|levitat|hover|flying)/.test(t) || undefined;
      let scale: number | undefined;
      if (/(colossal|gigantic|enormous|massive|huge|giant)/.test(t)) scale = kind === 'floating_island' ? 4 : 3;
      else if (/(big|large|grand)/.test(t)) scale = kind === 'floating_island' ? 3 : 2;
      else if (/(tiny|miniature|little)/.test(t)) scale = 0.4;
      else if (/\bsmall\b/.test(t)) scale = 0.6;
      const placement = /(above|over|in the sky|overhead|on top of the village)/.test(t) ? 'above' : /(left)/.test(t) ? 'left' : /(right)/.test(t) ? 'right' : /(behind)/.test(t) ? 'behind' : undefined;
      const name = t.match(/(?:called|named)\s+([a-z][a-z0-9 '-]{1,30}?)\s*$/)?.[1];
      push({
        op: 'spawn_object', kind,
        ...(placement ? { placement } : {}), ...(scale ? { scale } : {}), ...(glow ? { glow: true } : {}), ...(floating ? { floating: true } : {}),
        ...(colorFrom(t) ? { color: colorFrom(t) } : {}),
        ...(name ? { name: name.replace(/\b\w/g, (c) => c.toUpperCase()) } : {}),
      });
      continue;
    }

    // ——— object manipulation ———
    const ref = existingRef;
    if (ref) {
      const target = ref;
      if (/(delete|remove|destroy|banish|vanish|get rid|dissolve|erase)/.test(t)) { push({ op: 'delete_object', target }); continue; }
      if (/(larger|bigger|grow|enlarge|huge|taller|scale up)/.test(t)) { push({ op: 'transform_object', target, scale_by: multiplierFrom(t, 1.6) }); continue; }
      if (/(smaller|shrink|tiny|scale down|reduce)/.test(t)) { push({ op: 'transform_object', target, scale_by: 1 / multiplierFrom(t, 1.6) }); continue; }
      if (/(rotate|spin|turn)/.test(t)) { push({ op: 'transform_object', target, rotate_by: [0, /(around|full|360)/.test(t) ? Math.PI * 2 : Math.PI / 2, 0] }); continue; }
      const dir: Record<string, [number, number, number]> = { up: [0, 3, 0], higher: [0, 3, 0], down: [0, -3, 0], lower: [0, -3, 0], left: [-3, 0, 0], right: [3, 0, 0], closer: [0, 0, 3], away: [0, 0, -3], forward: [0, 0, -3], back: [0, 0, 3] };
      const d = Object.keys(dir).find((k) => new RegExp(`\\b${k}\\b`).test(t));
      if (/(move|lift|raise|push|pull|drop|bring|send)/.test(t) && d) { push({ op: 'transform_object', target, move_by: dir[d] }); continue; }
      if (/(float|levitat|hover|fly)/.test(t)) { push({ op: 'set_object_property', target, floating: !/(stop|land|ground|no longer)/.test(t) }); continue; }
      if (/(glow|shine|light up|illuminate)/.test(t)) { push({ op: 'set_object_property', target, glow: !/(stop|dim|no longer|turn off)/.test(t) }); continue; }
      if (colorFrom(t)) { push({ op: 'set_object_property', target, color: colorFrom(t) }); continue; }
      if (/(select|grab|pick up|choose)/.test(t)) { push({ op: 'select_object', target }); continue; }
      if (/(look at|focus|show me|view)/.test(t)) { push({ op: 'camera_focus', target }); continue; }
    }

    // ——— generic travel ———
    if (/(take me|go|travel|bring me|transport|teleport|enter|visit|return|back to|show me|i want to (see|go|explore)|open)/.test(t)) {
      const r = realmFrom(t);
      if (r) {
        if (r === 'cosmos' && /(miniature|create|make)/.test(t) && /solar/.test(t)) push({ op: 'cosmos_create_system', preset: 'solar_system' });
        ensureRealm(r);
        if (r === realm && out.commands.length === before) out.narration = `You are already in ${r}.`;
        continue;
      }
    }

    if (out.commands.length + out.unsupported.length === before) {
      out.unsupported.push({
        request: raw,
        reason: kind ? `I recognised "${kind.replace('_', ' ')}" but not what to do with it.` : "The offline parser didn't understand this request (the Nemotron Director handles much freer language when connected).",
        suggestion: suggestFor(realm),
      });
    }
  }

  // Validate our own output too — the parser gets no special trust.
  const { valid, issues } = validateCommands(out.commands);
  for (const i of issues) out.unsupported.push({ request: input, reason: `internal: ${i.error}` });
  out.commands = valid;
  return out;
}

function resolveObjectMention(t: string, s: WorldState): string | undefined {
  const inRealm = s.objects.filter((o) => o.realm === s.activeRealm);
  if (!inRealm.length) return undefined;
  for (const o of [...inRealm].reverse()) if (t.includes(` ${o.name.toLowerCase()} `) || t.includes(` ${o.name.toLowerCase()}`)) return o.id;
  const kind = KIND_WORDS.find(([re]) => re.test(t))?.[1];
  if (kind) {
    const o = resolveObject(s, kind);
    if (o) return o.id;
  }
  if (/\b(it|this|that|the object|selected)\b/.test(t)) return resolveObject(s, 'selected')?.id ?? inRealm[inRealm.length - 1].id;
  return undefined;
}

export function suggestFor(realm: RealmId): string {
  switch (realm) {
    case 'atom': return 'Try "switch to a 2p orbital", "excite the electron to 3d", "show where the electron is most likely to be found", or "open a portal to space".';
    case 'cosmos': return 'Try "make Jupiter 1000 times more massive", "slow down the simulation", "show me a black hole", or "open a portal to a fantasy kingdom".';
    case 'heavy': return 'Try "speed up time", "make gravity 2 times stronger", or "take me back to our universe".';
    case 'village': return 'Try "talk to Captain Ilsa", "create a floating island above the village", "make the sky purple", or "summon a dragon".';
    default: return 'Try "take me inside an atom", "open a portal to space", or "create a glowing crystal".';
  }
}

// Exported for tests.
export { resolveBody };
