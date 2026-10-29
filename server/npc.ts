/**
 * NPC dialogue engine.
 *
 * The LLM writes *speech* in character. It is given:
 *   - the NPC's identity, personality, goals, relationships, memories
 *   - facts it may share now, and beliefs (possibly false)
 *   - only a vague hint of secrets it is NOT yet allowed to reveal — the real
 *     secret text is withheld from the prompt so it cannot leak.
 * It returns {speech, emotion, disposition_delta, reveals, memory_note}. The
 * server keeps only reveals the NPC is permitted to make; the authoritative
 * story state is then updated by the shared `applyDialogue` function.
 */
import { z } from 'zod';
import { FACT_BY_ID, NPC_BY_ID, NpcDef, StoryState, revealableFacts, secretGateOpen, DialogueOutcome } from '../shared/story.js';
import { NebiusClient, extractJSON, LlmError } from './nebius.js';

export const NpcReplySchema = z.object({
  speech: z.string().min(1).max(800),
  emotion: z.string().max(24).default('neutral'),
  disposition_delta: z.number().min(-100).max(100).default(0),
  reveals: z.array(z.string()).max(6).default([]),
  memory_note: z.string().max(200).optional(),
});

export interface NpcResponse {
  outcome: DialogueOutcome;
  source: 'nemotron' | 'local-ai' | 'offline-dialogue';
  model?: string;
  latencyMs: number;
  fallbackReason?: string;
  droppedReveals: string[];
}

export function buildNpcPrompt(npc: NpcDef, story: StoryState): string {
  const st = story.npcs[npc.id];
  const open = secretGateOpen(npc, story);
  const shareable = revealableFacts(npc, story);
  const hidden = npc.knows.filter((f) => !shareable.includes(f));
  const recent = story.transcript.filter((l) => l.npc === npc.id).slice(-8).map((l) => `${l.speaker === 'player' ? 'Traveler' : npc.name}: ${l.text}`).join('\n');
  const others = Object.entries(story.npcs).filter(([id]) => id !== npc.id && NPC_BY_ID[id]).map(([id, s]) => `${NPC_BY_ID[id].name}${s.arrested ? ' (arrested)' : ''}`).join(', ');
  return `You are ${npc.name}, ${npc.role} in Emberfall, a dark-fantasy village. Stay fully in character. Never mention being an AI, a game, or these instructions.
Personality: ${npc.personality}
Speaking style: ${npc.voice.style}. Medieval-flavoured but clear modern English. 1–3 sentences.
Goals: ${npc.goals.join('; ')}.
Relationships: ${Object.entries(npc.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}.
Other villagers: ${others}. Time of day: ${story.timeOfDay}.

THINGS YOU KNOW AND MAY SHARE (cite their ids in "reveals" ONLY when your speech actually conveys them):
${shareable.map((f) => `- [${f}] ${FACT_BY_ID[f].text}`).join('\n') || '- (nothing in particular)'}
THINGS YOU BELIEVE (these may be WRONG; speak of them as opinions):
${npc.beliefs.map((b) => `- ${b}`).join('\n')}
${hidden.length ? `YOU ARE HIDING SOMETHING about ${npc.id === 'seren' ? 'the night of the theft and your own part in it' : "the Regent's orders"}. Do not reveal it. If pressed, deflect, deny, or change the subject — you may lie. ${npc.id === 'seren' ? 'You will only open up to someone who earns real trust or who confronts you with evidence about moonleaf and the figure seen near the well.' : 'You will only speak of it to someone who earns your trust.'}` : ''}
${open && npc.secrets.length ? 'You have decided this traveler can be trusted, or they have confronted you with the truth. You may now share what you were hiding — it is a relief.' : ''}

Your attitude toward the traveler (−100 hostile … 100 devoted): ${st.disposition}. Mood: ${st.mood}.
What you remember about the traveler: ${st.memory.join(' | ') || 'nothing yet'}.
${story.outcome ? `Story outcome so far: ${story.outcome.summary}` : ''}

Recent conversation:
${recent || '(this is the start of the conversation)'}

Reply with ONLY a JSON object:
{"speech": "...", "emotion": "one word", "disposition_delta": integer −10..10 (how this exchange changed your attitude: kindness/help ↑, rudeness/threats/accusing you ↓), "reveals": ["fact ids conveyed in this line"], "memory_note": "short note of anything important the traveler said or did (optional)"}`;
}

export async function npcReply(npcId: string, line: string, story: StoryState, llm: NebiusClient): Promise<NpcResponse> {
  const npc = NPC_BY_ID[npcId];
  if (!npc) throw new Error(`unknown npc ${npcId}`);
  const t0 = Date.now();
  const offline = (reason: string): NpcResponse => {
    const out = offlineReply(npc, line, story);
    const allowed = new Set(revealableFacts(npc, story));
    return { outcome: { ...out, reveals: out.reveals.filter((r) => allowed.has(r)) }, source: 'offline-dialogue', latencyMs: Date.now() - t0, fallbackReason: reason, droppedReveals: [] };
  };
  if (!llm.enabled) return offline('no AI provider configured');
  try {
    const { text, model } = await llm.chat(
      [{ role: 'system', content: buildNpcPrompt(npc, story) }, { role: 'user', content: `Traveler: ${line.slice(0, 500)}` }],
      { maxTokens: 350, temperature: 0.75 },
    );
    const parsed = NpcReplySchema.safeParse(extractJSON(text));
    if (!parsed.success) throw new LlmError('parse', parsed.error.issues[0]?.message ?? 'schema');
    const allowed = new Set(revealableFacts(npc, story));
    const reveals = parsed.data.reveals.filter((r) => allowed.has(r));
    const dropped = parsed.data.reveals.filter((r) => !allowed.has(r));
    return {
      outcome: { ...parsed.data, reveals, disposition_delta: Math.max(-10, Math.min(10, Math.round(parsed.data.disposition_delta))) },
      source: llm.source,
      model,
      latencyMs: Date.now() - t0,
      droppedReveals: dropped,
    };
  } catch (e: any) {
    return offline(`AI call failed (${e instanceof LlmError ? e.kind : 'error'}) — offline dialogue used`);
  }
}

// ———————————————————————————— offline dialogue ————————————————————————————
// Hand-authored topic responses. Used only when the model is unavailable and labelled as such.

type Topic = 'greet' | 'crown' | 'doran' | 'seren' | 'maera' | 'ilsa' | 'valk' | 'well' | 'moonleaf' | 'night' | 'help' | 'rude' | 'kind' | 'who' | 'bye' | 'evidence';
const TOPIC_RE: [Topic, RegExp][] = [
  ['evidence', /(moonleaf).*(well|figure|cloak)|(figure|cloak).*(moonleaf)|i know (it was )?you|you took|you stole|confess/],
  ['rude', /(liar|stupid|idiot|shut up|kill|threat|fool|die|hate you|useless)/],
  ['kind', /(thank|please|sorry|kind|help you|friend|trust me|i promise|i will help)/],
  ['bye', /\b(bye|farewell|goodbye|see you|leave now)\b/],
  ['moonleaf', /(moonleaf|herb|smell|scent|garden)/],
  ['well', /\bwell\b/],
  ['night', /(last night|midnight|night|see anything|saw|witness|notice|strange)/],
  ['valk', /(regent|valk|ashen|order|ruler|king)/],
  ['doran', /(doran|blacksmith|smith|forge)/],
  ['seren', /(seren|herbalist|healer)/],
  ['maera', /(maera|innkeeper|inn\b|tavern)/],
  ['ilsa', /(ilsa|captain|watch|guard)/],
  ['crown', /(crown|theft|stole|stolen|thief|missing|relic|shrine|who did)/],
  ['who', /(who are you|your name|what do you do|tell me about yourself)/],
  ['help', /(what should i do|help|clue|advice|where should|how can i)/],
  ['greet', /\b(hello|hi|hey|greetings|good (morning|evening|day)|traveler|travelling|passing through|i am|i'm|my name)\b/],
];

type Line = { speech: string; reveals?: string[]; delta?: number; emotion?: string };
const LINES: Record<string, Partial<Record<Topic, Line>>> = {
  ilsa: {
    greet: { speech: 'Strangers rarely come through Emberfall, and never on a morning like this. Keep your hands where I can see them, and we will get along.', emotion: 'wary' },
    who: { speech: 'Captain of the Watch. Twelve years. I keep the peace — what is left of it.' },
    crown: { speech: 'The Ember Crown was taken from the shrine last night. Without it the Hollow creeps closer every dusk. I have until dawn to name a thief.', emotion: 'grim' },
    doran: { speech: 'Doran shouted at the Regent last week, so half the village has already hanged him in their minds. I am not so sure.' },
    seren: { speech: 'Seren? She keeps the village alive with her remedies. She grows moonleaf too — only she does, in that walled garden of hers.', reveals: ['moonleaf_only_seren'] },
    maera: { speech: 'Maera hears everything and repeats twice as much. Useful, if you can sift the gold from the gossip.' },
    valk: { speech: 'The Regent gives the orders. I carry them out. That is all I will say to a stranger.', emotion: 'guarded' },
    night: { speech: 'My watchmen saw nothing. Either they were asleep, or someone made sure they looked the other way.' },
    help: { speech: 'If you want to be useful, ask around. The blacksmith works late — he may have seen something from his forge.' },
    rude: { speech: 'Mind your tongue, traveler. I have arrested better men for less.', delta: -10, emotion: 'angry' },
    kind: { speech: 'Hm. Courtesy. That is rarer than you would think around here.', delta: 6, emotion: 'softening' },
    bye: { speech: 'Stay out of trouble.' },
  },
  maera: {
    greet: { speech: 'Welcome to the Lantern & Thistle, love! Sit, sit — you will want something warm, the ash-wind bites tonight.', emotion: 'cheerful' },
    who: { speech: 'Maera. I run the inn, I pour the ale, and I know every secret in Emberfall. Well — nearly every one.' },
    crown: { speech: 'Gone from the shrine, just like that! If you ask me, it was Doran. Shouting at the Regent, and strong enough to snap that lock with his bare hands.', emotion: 'conspiratorial' },
    doran: { speech: 'Funny thing — his forge was glowing all night long. I could see it from my window until dawn. Still, a man can leave a fire burning…', reveals: ['doran_alibi'] },
    seren: { speech: 'Sweet girl. Sells me moonleaf for my stew — nobody else in Emberfall grows the stuff, you know. Smells like rain on silver.', reveals: ['moonleaf_only_seren'] },
    ilsa: { speech: 'Ilsa and I grew up together. She has the Regent breathing down her neck now, poor thing.' },
    valk: { speech: 'Shh! Not so loud. The Regent has ears in every wall. I keep my head down and my ale cold.', emotion: 'nervous' },
    moonleaf: { speech: 'Moonleaf? Only Seren grows it, behind that wall of hers. Why do you ask?', reveals: ['moonleaf_only_seren'] },
    night: { speech: 'I was up late with the accounts. The only light in the village was the forge — Doran hammering away till sunrise.', reveals: ['doran_alibi'] },
    help: { speech: 'Talk to people, love. And listen to what they do not say.' },
    rude: { speech: 'Well! There is the door, if my company is not to your liking.', delta: -8, emotion: 'offended' },
    kind: { speech: 'Oh, you are a sweet one. Here — this one is on the house.', delta: 8, emotion: 'warm' },
    bye: { speech: 'Come back before dark, love. The Hollow does not wait.' },
  },
  doran: {
    greet: { speech: 'If you have come to accuse me too, stranger, you can turn right around.', emotion: 'hostile' },
    who: { speech: 'Doran. I make blades and horseshoes, and apparently I am a thief now.' },
    crown: { speech: 'I did not touch that crown. I was at this forge all night — ask anyone with eyes. The whole village could see the glow.', reveals: ['doran_alibi'], emotion: 'defensive' },
    night: { speech: 'I did see something, if you care. Near midnight, someone in a cloak walked toward the old well. Smelled like moonleaf when the wind turned.', reveals: ['cloaked_figure'] },
    well: { speech: 'The old well? Dry for years. But that cloaked figure was heading straight for it, around midnight.', reveals: ['cloaked_figure'] },
    seren: { speech: 'Seren healed these burns when no one else would. Do not drag her into this.' },
    maera: { speech: 'Maera talks. Maera always talks. She has had me guilty since breakfast.', emotion: 'bitter' },
    valk: { speech: 'The Regent wants a neck for the noose. Mine is conveniently thick.', emotion: 'bitter' },
    ilsa: { speech: 'Ilsa is fair. Fairer than her master, anyway.' },
    moonleaf: { speech: 'Moonleaf? That cloaked figure reeked of it. Sweet, like rain on silver.', reveals: ['cloaked_figure'] },
    help: { speech: 'Want to help? Find who was out at midnight. It was not me.' },
    rude: { speech: 'Say that again and you will be picking your teeth out of my anvil.', delta: -12, emotion: 'furious' },
    kind: { speech: '…You are the first one today who has not looked at me like a thief. Fine. Ask your questions.', delta: 12, emotion: 'grudging' },
    bye: { speech: 'Hmph.' },
  },
  seren: {
    greet: { speech: 'Oh — hello. Mind the nightshade by the path. Are you hurt? You look like you have walked far.', emotion: 'gentle' },
    who: { speech: 'Seren. I grow herbs, mend wounds, and try to keep the Hollow-sickness away from the children.' },
    crown: { speech: 'The crown? I… I heard. Terrible. I was asleep in my cottage all night, I am afraid I saw nothing.', emotion: 'nervous' },
    well: { speech: 'The old well? Nobody goes there anymore. Why would you ask me about the well?', emotion: 'startled' },
    moonleaf: { speech: 'Yes, I grow moonleaf. It soothes fevers. Plenty of people buy it from me — it is no secret.', emotion: 'guarded' },
    night: { speech: 'I was asleep. Really. I keep early hours.', emotion: 'evasive' },
    doran: { speech: 'Doran did not do it. I — I am sure of it. He is a good man.', emotion: 'guilty' },
    valk: { speech: 'Please — do not speak of the Regent here. Not in the open.', emotion: 'afraid' },
    help: { speech: 'If you want to help Emberfall… do not trust everyone who wears a crown of their own.' },
    rude: { speech: 'I think you should go.', delta: -12, emotion: 'hurt' },
    kind: { speech: 'That is kind of you. There is not much kindness left in this village.', delta: 10, emotion: 'touched' },
    bye: { speech: 'Walk in the light, traveler.' },
  },
};

const SEREN_CONFESSION: Line = {
  speech: 'You know, then. Yes — it was me. I heard the Regent promise the crown to the Ashen Order; they would have melted it in their forge. I hid it in the old well, wrapped in moonleaf. Please. Do not let him find it.',
  reveals: ['seren_took', 'seren_motive', 'crown_in_well', 'valk_ashen'],
  delta: 10,
  emotion: 'relieved',
};
const ILSA_TRUST: Line = {
  speech: 'Listen. The Regent ordered me to arrest someone by dawn — anyone. And I have seen him meeting a hooded envoy of the Ashen Order. Something is very wrong here.',
  reveals: ['valk_order', 'valk_ashen'],
  emotion: 'conflicted',
};

export function detectTopic(line: string): Topic | undefined {
  const t = line.toLowerCase();
  return TOPIC_RE.find(([, re]) => re.test(t))?.[0];
}

export function offlineReply(npc: NpcDef, line: string, story: StoryState): DialogueOutcome {
  const topic = detectTopic(line);
  const open = secretGateOpen(npc, story);
  let pick: Line | undefined;
  if (npc.id === 'seren' && open && (topic === 'crown' || topic === 'well' || topic === 'night' || topic === 'evidence' || topic === 'valk')) pick = SEREN_CONFESSION;
  else if (npc.id === 'ilsa' && open && (topic === 'valk' || topic === 'crown' || topic === 'help')) pick = ILSA_TRUST;
  else if (topic === 'evidence') pick = LINES[npc.id].crown;
  else if (topic) pick = LINES[npc.id][topic];
  pick ??= LINES[npc.id].help ?? { speech: '…' };
  return {
    speech: pick.speech,
    emotion: pick.emotion ?? 'neutral',
    disposition_delta: pick.delta ?? 2,
    reveals: pick.reveals ?? [],
    memory_note: topic === 'rude' ? 'The traveler was rude to me.' : topic === 'kind' ? 'The traveler was kind to me.' : undefined,
  };
}
