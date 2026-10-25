/**
 * Emberfall — the living-story world.
 *
 * Design rule: AUTHORITATIVE FACTS live here and only change through validated
 * world operations. NPC dialogue (LLM-generated or offline) is *speech* — an NPC
 * may lie, be mistaken, or refuse — but what the player has actually learned is
 * tracked only through `reveals`, which the server checks against each NPC's
 * knowledge and secret gates. The truth is never decided by the language model.
 */

export interface Fact {
  id: string;
  text: string;
  /** a clue the player can collect */
  clue?: boolean;
}

export const FACTS: Fact[] = [
  { id: 'crown_missing', text: 'The Ember Crown, the relic that keeps the creeping Hollow away from Emberfall, vanished from the shrine last night.' },
  { id: 'seren_took', text: 'Seren the herbalist took the Ember Crown from the shrine at midnight.', clue: true },
  { id: 'seren_motive', text: 'Seren overheard Regent Valk promise the crown to the Ashen Order, who would melt it in their forge; she hid it to protect the village.', clue: true },
  { id: 'crown_in_well', text: 'The crown is hidden at the bottom of the old well, wrapped in moonleaf cloth.', clue: true },
  { id: 'doran_alibi', text: 'Doran the blacksmith worked his forge all night; its glow was visible from the inn until dawn.', clue: true },
  { id: 'cloaked_figure', text: 'Around midnight a cloaked figure smelling of moonleaf walked toward the old well.', clue: true },
  { id: 'moonleaf_only_seren', text: 'Only Seren grows moonleaf in Emberfall, in the walled garden behind her cottage.', clue: true },
  { id: 'valk_order', text: 'Regent Valk ordered Captain Ilsa to arrest a culprit by dawn — any culprit.', clue: true },
  { id: 'valk_ashen', text: 'Regent Valk has been meeting secretly with a hooded envoy of the Ashen Order.', clue: true },
];
export const FACT_BY_ID = Object.fromEntries(FACTS.map((f) => [f.id, f]));

export interface NpcDef {
  id: string;
  name: string;
  role: string;
  personality: string;
  goals: string[];
  /** facts this NPC truly knows */
  knows: string[];
  /** things the NPC believes that may be FALSE */
  beliefs: string[];
  /** facts the NPC hides; revealed only when the gate is satisfied */
  secrets: string[];
  secretGate?: { minDisposition?: number; orPlayerKnows?: string[] };
  /** how they speak */
  voice: { pitch: number; rate: number; style: string };
  color: string;
  /** routine: waypoint name per time-of-day */
  routine: Record<'dawn' | 'day' | 'dusk' | 'night', string>;
  greeting: string;
  relationships: Record<string, string>;
}

export const NPCS: NpcDef[] = [
  {
    id: 'ilsa',
    name: 'Captain Ilsa',
    role: 'Captain of the Emberfall Watch',
    personality: 'Dutiful, terse, observant, suspicious of strangers; privately uneasy about the Regent.',
    goals: ['Find the crown thief before dawn', 'Keep the village calm', 'Find out what the Regent is hiding'],
    knows: ['crown_missing', 'valk_order', 'valk_ashen', 'moonleaf_only_seren'],
    beliefs: ['A stranger arriving the morning after a theft is worth watching.'],
    secrets: ['valk_order', 'valk_ashen'],
    secretGate: { minDisposition: 25, orPlayerKnows: ['seren_motive'] },
    voice: { pitch: 0.9, rate: 1.0, style: 'clipped, military' },
    color: '#4a6fa5',
    routine: { dawn: 'gate', day: 'square', dusk: 'gate', night: 'watchtower' },
    greeting: 'Traveler, you seem unfamiliar. What brings you to Emberfall on the morning the crown goes missing?',
    relationships: { doran: 'respects his work, but he argued with the Regent last week', seren: 'trusts her remedies', maera: 'old friend', valk: 'serves him, distrusts him' },
  },
  {
    id: 'maera',
    name: 'Maera',
    role: 'Innkeeper of the Lantern & Thistle',
    personality: 'Warm, talkative, loves gossip, quick to judge, generous to guests.',
    goals: ['Keep her inn full', 'Learn every secret in the village', 'See the crown returned before the Hollow comes'],
    knows: ['crown_missing', 'doran_alibi', 'moonleaf_only_seren'],
    beliefs: ['Doran stole the crown — he shouted at the Regent last week and he has the strength to break the shrine lock.'],
    secrets: [],
    voice: { pitch: 1.15, rate: 1.05, style: 'chatty, folksy' },
    color: '#b5651d',
    routine: { dawn: 'inn', day: 'inn', dusk: 'square', night: 'inn' },
    greeting: 'Well now! A new face. Come in out of the ash-wind, love — have you heard about the crown?',
    relationships: { doran: 'suspects him', seren: 'buys her herbs', ilsa: 'old friend', valk: 'fears him' },
  },
  {
    id: 'doran',
    name: 'Doran',
    role: 'Blacksmith',
    personality: 'Gruff, proud, honest to a fault, short-tempered when accused, kind underneath.',
    goals: ['Clear his name', 'Protect his apprentice', 'Stand up to the Regent'],
    knows: ['crown_missing', 'doran_alibi', 'cloaked_figure'],
    beliefs: ['The Regent wants someone to hang for this, and he would be a convenient choice.'],
    secrets: [],
    voice: { pitch: 0.7, rate: 0.92, style: 'gruff, blunt' },
    color: '#7a3b2e',
    routine: { dawn: 'forge', day: 'forge', dusk: 'forge', night: 'square' },
    greeting: 'If you have come to accuse me too, stranger, you can turn right around.',
    relationships: { maera: 'knows she gossips about him', seren: 'she healed his burns once', ilsa: 'respects her', valk: 'despises him' },
  },
  {
    id: 'seren',
    name: 'Seren',
    role: 'Herbalist',
    personality: 'Gentle, clever, guarded, fiercely protective of Emberfall; lies smoothly when frightened.',
    goals: ['Keep the crown away from the Ashen Order', 'Avoid being discovered', 'Find someone she can trust'],
    knows: ['crown_missing', 'seren_took', 'seren_motive', 'crown_in_well', 'moonleaf_only_seren', 'valk_ashen'],
    beliefs: ['If the Regent learns where the crown is, the village is doomed.'],
    secrets: ['seren_took', 'seren_motive', 'crown_in_well', 'valk_ashen'],
    secretGate: { minDisposition: 45, orPlayerKnows: ['cloaked_figure', 'moonleaf_only_seren'] },
    voice: { pitch: 1.25, rate: 0.95, style: 'soft, careful' },
    color: '#3f7f5f',
    routine: { dawn: 'garden', day: 'square', dusk: 'well', night: 'garden' },
    greeting: 'Oh — hello. Mind the nightshade by the path. Are you hurt? You look like you have walked far.',
    relationships: { maera: 'a good customer', doran: 'feels guilty he is suspected', ilsa: 'fears she will be caught by her', valk: 'terrified of him' },
  },
];
export const NPC_BY_ID = Object.fromEntries(NPCS.map((n) => [n.id, n]));

export interface NpcState {
  disposition: number; // −100 … 100 toward the player
  memory: string[]; // short notes of important things the player said/did
  talkedTimes: number;
  mood: string;
  arrested?: boolean;
}

export interface StoryState {
  title: string;
  npcs: Record<string, NpcState>;
  /** fact ids the player has genuinely learned (validated reveals) */
  playerKnows: string[];
  activeConversation?: string;
  outcome?: { kind: 'truth_revealed' | 'accused_without_proof' | 'injustice'; accused: string; summary: string };
  reputation: number;
  transcript: { npc: string; speaker: 'player' | 'npc'; text: string; t: number; source?: string }[];
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night';
}

export function initialStory(): StoryState {
  return {
    title: 'The Ember Crown',
    npcs: Object.fromEntries(
      NPCS.map((n) => [n.id, { disposition: n.id === 'doran' ? -10 : n.id === 'ilsa' ? -5 : 10, memory: [], talkedTimes: 0, mood: 'neutral' }]),
    ),
    playerKnows: ['crown_missing'],
    reputation: 0,
    transcript: [],
    timeOfDay: 'dusk',
  };
}

export function resolveNpc(target: string): NpcDef | undefined {
  const t = target.toLowerCase().trim();
  return (
    NPCS.find((n) => n.id === t) ??
    NPCS.find((n) => n.name.toLowerCase() === t) ??
    NPCS.find((n) => n.name.toLowerCase().includes(t) || t.includes(n.id)) ??
    NPCS.find((n) => n.role.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)))
  );
}

/** Can this NPC reveal its secrets to the player right now? */
export function secretGateOpen(npc: NpcDef, story: StoryState): boolean {
  if (!npc.secretGate) return true;
  const st = story.npcs[npc.id];
  if (npc.secretGate.minDisposition !== undefined && st.disposition >= npc.secretGate.minDisposition) return true;
  if (npc.secretGate.orPlayerKnows && npc.secretGate.orPlayerKnows.every((f) => story.playerKnows.includes(f))) return true;
  return false;
}

/** Which fact ids the NPC is permitted to reveal right now. */
export function revealableFacts(npc: NpcDef, story: StoryState): string[] {
  const open = secretGateOpen(npc, story);
  return npc.knows.filter((f) => open || !npc.secrets.includes(f));
}

export interface DialogueOutcome {
  speech: string;
  emotion: string;
  disposition_delta: number;
  reveals: string[];
  memory_note?: string;
}

/**
 * Apply a (validated) dialogue turn to the story. Reveals not permitted by the
 * NPC's knowledge or secret gate are dropped and reported.
 */
export function applyDialogue(
  story: StoryState,
  npcId: string,
  playerLine: string,
  out: DialogueOutcome,
  source: string,
): { story: StoryState; accepted: string[]; rejected: string[] } {
  const npc = NPC_BY_ID[npcId];
  if (!npc) throw new Error(`unknown npc ${npcId}`);
  const s: StoryState = structuredClone(story);
  const allowed = new Set(revealableFacts(npc, s));
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const f of out.reveals ?? []) {
    if (allowed.has(f) && FACT_BY_ID[f]) {
      if (!s.playerKnows.includes(f)) s.playerKnows.push(f);
      accepted.push(f);
    } else rejected.push(f);
  }
  const st = s.npcs[npcId];
  const delta = Math.max(-20, Math.min(20, Math.round(out.disposition_delta || 0)));
  st.disposition = Math.max(-100, Math.min(100, st.disposition + delta));
  st.mood = out.emotion || st.mood;
  st.talkedTimes += 1;
  if (out.memory_note) {
    st.memory.push(out.memory_note.slice(0, 200));
    if (st.memory.length > 12) st.memory.shift();
  }
  const t = Date.now();
  s.transcript.push({ npc: npcId, speaker: 'player', text: playerLine.slice(0, 500), t });
  s.transcript.push({ npc: npcId, speaker: 'npc', text: out.speech.slice(0, 800), t: t + 1, source });
  if (s.transcript.length > 200) s.transcript.splice(0, s.transcript.length - 200);
  return { story: s, accepted, rejected };
}

/** Story decision: accusing someone of the theft. Consequences are deterministic. */
export function accuse(story: StoryState, npcId: string): { story: StoryState; message: string } {
  const s: StoryState = structuredClone(story);
  const npc = NPC_BY_ID[npcId];
  const hasProof = ['cloaked_figure', 'moonleaf_only_seren'].every((f) => s.playerKnows.includes(f));
  if (npcId === 'seren') {
    if (hasProof) {
      s.outcome = {
        kind: 'truth_revealed',
        accused: 'seren',
        summary:
          'Faced with the moonleaf trail, Seren confesses — and reveals why: Regent Valk promised the crown to the Ashen Order. Captain Ilsa turns her blade toward the Regent. The crown is raised from the old well.',
      };
      for (const f of ['seren_took', 'seren_motive', 'crown_in_well', 'valk_ashen']) if (!s.playerKnows.includes(f)) s.playerKnows.push(f);
      s.npcs.seren.disposition = Math.max(s.npcs.seren.disposition, 20);
      s.npcs.ilsa.disposition = Math.min(100, s.npcs.ilsa.disposition + 30);
      s.reputation += 30;
    } else {
      s.outcome = {
        kind: 'accused_without_proof',
        accused: 'seren',
        summary: 'Seren denies everything, and with no evidence Captain Ilsa refuses to act. Seren will not trust you now.',
      };
      s.npcs.seren.disposition = Math.max(-100, s.npcs.seren.disposition - 40);
      s.reputation -= 10;
    }
  } else {
    s.outcome = {
      kind: 'injustice',
      accused: npcId,
      summary: `${npc.name} is dragged before the Regent for a crime they did not commit. The real thief stays hidden — and the Regent smiles.`,
    };
    s.npcs[npcId].arrested = true;
    s.npcs[npcId].disposition = -100;
    s.reputation -= 25;
  }
  return { story: s, message: s.outcome.summary };
}
