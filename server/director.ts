/**
 * AI Experience Director.
 *
 * Natural language → validated structured commands. Uses an NVIDIA Nemotron
 * model on Nebius Token Factory when configured; otherwise (or on any failure)
 * falls back to the deterministic local parser and says so in `source` and
 * `fallbackReason`. The Director never executes anything — it only proposes.
 */
import {
  COMMAND_DOCS,
  CommandSchema,
  DirectorReply,
  DirectorReplySchema,
  validateCommands,
  REALM_INFO,
  OBJECT_KINDS,
} from "../shared/commands.js";
import { z } from "zod";
import { parseIntent } from "../shared/localParser.js";
import { WorldState, summarizeWorld } from "../shared/worldState.js";
import { NebiusClient, extractJSON, LlmError } from "./nebius.js";

// Ollama's constrained decoder uses homogeneous arrays, with min/maxItems for
// fixed-size vectors. Validation below still checks the exact tuple and ranges.
function decoderSchema(value: any): any {
  if (Array.isArray(value)) return value.map(decoderSchema);
  if (!value || typeof value !== "object") return value;
  const result: any = {};
  for (const [key, child] of Object.entries(value))
    if (key !== "$schema") result[key] = decoderSchema(child);
  if (result.prefixItems) {
    const tuple = result.prefixItems;
    delete result.prefixItems;
    result.items = tuple[0];
    result.minItems = result.maxItems = tuple.length;
  }
  return result;
}
export const DIRECTOR_OUTPUT_SCHEMA = decoderSchema(
  z.toJSONSchema(
    z.object({
      narration: z.string().max(1200),
      commands: z.array(CommandSchema).max(12),
      unsupported: z
        .array(
          z.object({
            request: z.string(),
            reason: z.string(),
            suggestion: z.string().optional(),
          }),
        )
        .max(12),
    }),
  ),
);

export function buildDirectorPrompt(world: WorldState): string {
  const docs = Object.entries(COMMAND_DOCS)
    .map(([op, d]) => `- ${op}: ${d}`)
    .join("\n");
  return `You are the AI Experience Director of ANANT, an engine that turns imagination into explorable, interactive realities.
Your job: translate the user's request into STRUCTURED COMMANDS that the engine can execute. You never write code.

REALMS
- nexus: ${REALM_INFO.nexus.blurb} (hub)
- atom: ${REALM_INFO.atom.blurb} (SCIENTIFIC)
- cosmos: ${REALM_INFO.cosmos.blurb} (SCIENTIFIC; units AU / years / solar masses)
- village: ${REALM_INFO.village.blurb} (IMAGINATIVE; NPCs: ilsa, maera, doran, seren)
- heavy: ${REALM_INFO.heavy.blurb} (HYPOTHETICAL universe — always call it hypothetical; observe-only, bodies cannot be edited)

COMMANDS (the ONLY operations that exist)
${docs}

RULES
1. Output ONLY one JSON object: {"narration": string, "commands": [ {"op": ..., ...} ], "unsupported": [ {"request", "reason", "suggestion"} ]}.
2. Use only the ops and parameters above. Object kinds: ${OBJECT_KINDS.join(", ")}. Map close synonyms (e.g. "fortress"→castle, "gem"→crystal). Colors are #rrggbb.
3. If a request needs a different realm, put go_to_realm FIRST (e.g. orbitals need the atom realm, planet edits need cosmos, NPCs need village).
4. If something cannot be done with these commands, do NOT pretend: add it to "unsupported" with an honest reason and a supported suggestion. Never claim an action happened — the engine reports results.
5. narration: one or two vivid sentences describing what you are attempting (future tense or present intent), max 40 words. For scientific questions, explain accurately and briefly, and flag simplifications/artistic effects.
6. Quantum numbers: 1≤n≤4, 0≤l<n, |m|≤l. 2p=(2,1,0), 2p_x=(2,1,1), 3d_z²=(3,2,0). Use atom_transition when the user wants the electron to jump/excite/decay.
7. Mass changes: use cosmos_set_body with mass_multiplier. "much more massive" ≈ 100–1000 so the effect is visible.
8. Targets may be object ids, names, kinds, or "selected"/"last".
9. To converse with an NPC, emit talk_to; the dialogue engine handles the actual conversation.
10. Every position, move_to, move_by and rotation is an array [x,y,z], never one number or an {x,y,z} object. AU distances are scalar only in orbit_au/distance fields. For relative moves use toward and fraction.
11. The black-hole view is separate from the Newtonian solar system. To bring Earth (or another planet) near it use cosmos_black_hole {show:true, companion:"earth", distance_rs:22}. Do not move a solar-system body to an invented black-hole coordinate. This is an illustrative encounter; planetary size is enlarged and no tidal/fluid simulation is performed.

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

export async function direct(
  input: string,
  world: WorldState,
  llm: NebiusClient,
): Promise<DirectorReply> {
  const t0 = Date.now();
  const local = (reason: string): DirectorReply => {
    const p = parseIntent(input, world);
    return {
      ...p,
      issues: [],
      source: "local-parser",
      latencyMs: Date.now() - t0,
      fallbackReason: reason,
    };
  };
  if (!input.trim())
    return {
      narration: "",
      commands: [],
      unsupported: [],
      issues: [],
      source: "local-parser",
      fallbackReason: "empty input",
    };
  // The ray-integrated encounter has its own coordinates. A model must not
  // silently move a hidden AU body while the user is looking at this view.
  const builtIn = parseIntent(input, world);
  if (
    builtIn.commands.some(
      (command) =>
        command.op === "cosmos_black_hole" &&
        (command.companion || command.distance_rs !== undefined),
    )
  )
    return local("Used the built-in black-hole encounter command");
  if (!llm.enabled)
    return local("no AI provider configured — running the offline parser");

  const messages = [
    { role: "system" as const, content: buildDirectorPrompt(world) },
    { role: "user" as const, content: input.slice(0, 1000) },
  ];
  try {
    let reply = await llm.chat(messages, {
      maxTokens: 1100,
      temperature: 0.2,
      schema: DIRECTOR_OUTPUT_SCHEMA,
    });
    let shape: z.infer<typeof DirectorReplySchema> | undefined;
    let validation: ReturnType<typeof validateCommands> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let error = "";
      shape=undefined;validation=undefined;
      try {
        shape = DirectorReplySchema.parse(extractJSON(reply.text));
        validation = validateCommands(shape.commands);
        error = validation.issues
          .map(
            (issue) => `Command ${issue.index} (${issue.op}): ${issue.error}`,
          )
          .join("; ");
        if (!error) break;
      } catch (e: any) {
        error = String(e.message).slice(0, 1800);
      }
      if (attempt === 0)
        reply = await llm.chat(
          [
            ...messages,
            { role: "assistant", content: reply.text.slice(0, 6000) },
            {
              role: "user",
              content: `The proposed action has NOT run. Repair the complete command plan: ${error}. Preserve the user's requested outcome. Vectors must be [x,y,z]; do not replace a missing action with only configuration changes. Reply with the corrected JSON object.`,
            },
          ],
          { maxTokens: 1100, temperature: 0, schema: DIRECTOR_OUTPUT_SCHEMA },
        );
    }
    if (!shape || !validation)
      throw new LlmError("parse", "No valid command plan after repair");
    const { valid, issues } = validation;
    if (issues.length) {
      const fallback = parseIntent(input, world);
      if (fallback.commands.length && !fallback.unsupported.length)
        return local(
          "AI command validation failed after repair — used the supported offline command plan",
        );
      if (
        valid.every((command) =>
          ["go_to_realm", "cosmos_set_mode"].includes(command.op),
        )
      )
        valid.length = 0;
    }
    return {
      narration: shape.narration,
      commands: valid,
      unsupported: shape.unsupported,
      issues,
      source: llm.source,
      model: reply.model,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    const kind = e instanceof LlmError ? e.kind : "error";
    return local(
      `AI call failed (${kind}: ${String(e.message).slice(0, 160)}) — used the offline parser`,
    );
  }
}
