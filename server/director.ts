/**
 * AI Experience Director.
 *
 * Natural language → validated structured commands. Uses an NVIDIA Nemotron
 * model on Nebius Token Factory when configured; otherwise (or on any failure)
 * falls back to the deterministic local parser and says so in `source` and
 * `fallbackReason`. The Director never executes anything — it only proposes.
 */
import { COMMAND_DOCS, DirectorReply, DirectorReplySchema, validateCommands, REALM_INFO, OBJECT_KINDS } from '../shared/commands.js';
import { parseIntent } from '../shared/localParser.js';
import { WorldState, summarizeWorld } from '../shared/worldState.js';
import { NebiusClient, extractJSON, LlmError } from './nebius.js';

export function buildDirectorPrompt(world: WorldState): string {
  const docs = Object.entries(COMMAND_DOCS).map(([op, d]) => `- ${op}: ${d}`).join('\n');
  return `You are the AI Experience Director of ANANT, an engine that turns imagination into explorable, interactive realities.
Your job: translate the user's request into STRUCTURED COMMANDS that the engine can execute. You never write code.

REALMS
- nexus: ${REALM_INFO.nexus.blurb} (hub)
- atom: ${REALM_INFO.atom.blurb} (SCIENTIFIC)
- cosmos: ${REALM_INFO.cosmos.blurb} (SCIENTIFIC; units AU / years / solar masses)
- village: ${REALM_INFO.village.blurb} (IMAGINATIVE; NPCs: ilsa, maera, doran, seren)

COMMANDS (the ONLY operations that exist)
${docs}

RULES
1. Output ONLY one JSON object: {"narration": string, "commands": [ {"op": ..., ...} ], "unsupported": [ {"request", "reason", "suggestion"} ]}.
2. Use only the ops and parameters above. Object kinds: ${OBJECT_KINDS.join(', ')}. Map close synonyms (e.g. "fortress"→castle, "gem"→crystal). Colors are #rrggbb.
3. If a request needs a different realm, put go_to_realm FIRST (e.g. orbitals need the atom realm, planet edits need cosmos, NPCs need village).
4. If something cannot be done with these commands, do NOT pretend: add it to "unsupported" with an honest reason and a supported suggestion. Never claim an action happened — the engine reports results.
5. narration: one or two vivid sentences describing what you are attempting (future tense or present intent), max 40 words. For scientific questions, explain accurately and briefly, and flag simplifications/artistic effects.
6. Quantum numbers: 1≤n≤4, 0≤l<n, |m|≤l. 2p=(2,1,0), 2p_x=(2,1,1), 3d_z²=(3,2,0). Use atom_transition when the user wants the electron to jump/excite/decay.
7. Mass changes: use cosmos_set_body with mass_multiplier. "much more massive" ≈ 100–1000 so the effect is visible.
8. Targets may be object ids, names, kinds, or "selected"/"last".
9. To converse with an NPC, emit talk_to; the dialogue engine handles the actual conversation.

EXAMPLES
User: "Take me inside an atom and show me the 2p orbital"
{"narration":"Shrinking you down past the scale of light itself, into a hydrogen atom.","commands":[{"op":"go_to_realm","realm":"atom"},{"op":"atom_set_orbital","n":2,"l":1,"m":0}],"unsupported":[]}
User: "create a floating island above the village and put a castle on it"
{"narration":"Earth tears itself from the ground and rises; stone walls follow.","commands":[{"op":"spawn_object","kind":"floating_island","placement":"above"},{"op":"spawn_object","kind":"castle"},{"op":"transform_object","target":"last","place_on":"floating_island"}],"unsupported":[]}
User: "show me what this place looked like 100 years ago"
{"narration":"","commands":[],"unsupported":[{"request":"show me what this place looked like 100 years ago","reason":"Historical reconstructions are not available in this prototype.","suggestion":"Ask a villager about the past, or freeze time."}]}

CURRENT WORLD STATE
${JSON.stringify(summarizeWorld(world))}`;
}

export async function direct(input: string, world: WorldState, llm: NebiusClient): Promise<DirectorReply> {
  const t0 = Date.now();
  const local = (reason: string): DirectorReply => {
    const p = parseIntent(input, world);
    return { ...p, issues: [], source: 'local-parser', latencyMs: Date.now() - t0, fallbackReason: reason };
  };
  if (!input.trim()) return { narration: '', commands: [], unsupported: [], issues: [], source: 'local-parser', fallbackReason: 'empty input' };
  if (!llm.enabled) return local('no NEBIUS_API_KEY configured — running the offline parser');

  const messages = [
    { role: 'system' as const, content: buildDirectorPrompt(world) },
    { role: 'user' as const, content: input.slice(0, 1000) },
  ];
  try {
    let { text, model } = await llm.chat(messages, { maxTokens: 700, temperature: 0.3 });
    let parsed: unknown;
    try {
      parsed = extractJSON(text);
    } catch (e: any) {
      // One repair attempt: show the model its malformed output.
      const repair = await llm.chat(
        [...messages, { role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: `That was not a valid JSON object (${e.message}). Reply again with ONLY the JSON object.` }],
        { maxTokens: 700, temperature: 0 },
      );
      text = repair.text;
      model = repair.model;
      parsed = extractJSON(text);
    }
    const shape = DirectorReplySchema.safeParse(parsed);
    if (!shape.success) throw new LlmError('parse', `reply did not match schema: ${shape.error.issues[0]?.message}`);
    const { valid, issues } = validateCommands(shape.data.commands);
    return {
      narration: shape.data.narration,
      commands: valid,
      unsupported: shape.data.unsupported,
      issues,
      source: 'nemotron',
      model,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    const kind = e instanceof LlmError ? e.kind : 'error';
    return local(`Nemotron call failed (${kind}: ${String(e.message).slice(0, 160)}) — used the offline parser`);
  }
}
