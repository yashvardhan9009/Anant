import { z } from "zod";

export const EFFECTS = [
  "fire",
  "water",
  "ice",
  "lightning",
  "vortex",
  "portal",
  "fireflies",
  "steam",
] as const;
export type EffectKind = (typeof EFFECTS)[number];
const position = z.tuple([
  z.number().min(-100).max(100),
  z.number().min(0).max(60),
  z.number().min(-100).max(100),
]);
const color = z.string().regex(/^#[\da-f]{6}$/i);
export const ScenePlanSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(700),
  environment: z.object({
    ground: z.enum(["grass", "stone", "sand", "snow", "obsidian"]),
    time: z.enum(["day", "golden", "blue", "night"]),
    weather: z.enum(["clear", "mist", "rain", "snow"]),
    sky: color,
    aurora: z.boolean(),
  }),
  objects: z
    .array(
      z.object({
        kind: z.enum([
          "dragon",
          "tree",
          "rock",
          "house",
          "column",
          "arch",
          "pyramid",
          "sphere",
          "box",
          "torus",
          "crystal",
          "dome",
          "firepit",
          "basin",
        ]),
        position,
        rotation: z.number().min(-180).max(180).optional(),
        scale: z.tuple([
          z.number().min(0.1).max(40),
          z.number().min(0.1).max(40),
          z.number().min(0.1).max(40),
        ]),
        color,
        material: z.enum(["stone", "wood", "metal", "glass", "light"]),
        motion: z.enum(["still", "float", "spin"]),
      }),
    )
    .max(60),
  effects: z
    .array(
      z.object({
        kind: z.enum(EFFECTS),
        position,
        size: z.number().min(0.3).max(12),
        color,
      }),
    )
    .max(12),
  reconstruction: z
    .object({
      period: z.string().max(100),
      interpretation: z.string().max(800),
    })
    .nullable(),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
/** Still objects need support. Keep deliberately floating objects aloft and
 * preserve stacked architecture when its base meets another object's top. */
export function settleScene(plan: ScenePlan): ScenePlan {
  const next = structuredClone(plan);
  const dimensions: Record<
    ScenePlan["objects"][number]["kind"],
    [number, number, number]
  > = {
    house: [4, 4, 3.5],
    column: [1, 3.14, 1],
    arch: [2, 2.5, 0.5],
    tree: [3, 6, 3],
    rock: [2, 2, 2],
    sphere: [2, 2, 2],
    box: [2, 2, 2],
    torus: [2.3, 2.4, 0.4],
    crystal: [2, 2, 2],
    dome: [2, 1, 2],
    pyramid: [2, 2, 2],
    firepit: [1.6, 0.55, 1.6],
    basin: [2, 0.35, 2],
    dragon: [9.5, 5, 8],
  };
  const settled: ScenePlan["objects"] = [];
  for (const item of [...next.objects].sort(
    (a, b) => a.position[1] - b.position[1],
  )) {
    if (item.motion !== "still") {
      continue;
    }
    const original = item.position[1],
      dim = dimensions[item.kind];
    let support = 0;
    for (const other of settled) {
      const od = dimensions[other.kind],
        top = other.position[1] + od[1] * other.scale[1];
      if (
        Math.abs(original - top) < 0.65 &&
        Math.abs(item.position[0] - other.position[0]) <
          (dim[0] * item.scale[0] + od[0] * other.scale[0]) * 0.45 &&
        Math.abs(item.position[2] - other.position[2]) <
          (dim[2] * item.scale[2] + od[2] * other.scale[2]) * 0.45
      )
        support = Math.max(support, top);
    }
    item.position[1] = support;
    settled.push(item);
  }
  return next;
}
export const SceneEditSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(700),
  environment: ScenePlanSchema.shape.environment.nullable(),
  removeObjectIndices: z.array(z.number().int().min(0).max(59)).max(60),
  addObjects: ScenePlanSchema.shape.objects,
  removeEffectIndices: z.array(z.number().int().min(0).max(11)).max(12),
  addEffects: ScenePlanSchema.shape.effects,
});
export function applySceneEdit(
  current: ScenePlan,
  edit: z.infer<typeof SceneEditSchema>,
): ScenePlan {
  if (
    edit.removeObjectIndices.some((i) => i >= current.objects.length) ||
    edit.removeEffectIndices.some((i) => i >= current.effects.length)
  )
    throw Error("Scene edit refers to a missing item");
  return ScenePlanSchema.parse({
    ...current,
    title: edit.title,
    description: edit.description,
    environment: edit.environment ?? current.environment,
    objects: [
      ...current.objects.filter(
        (_, i) => !edit.removeObjectIndices.includes(i),
      ),
      ...edit.addObjects,
    ],
    effects: [
      ...current.effects.filter(
        (_, i) => !edit.removeEffectIndices.includes(i),
      ),
      ...edit.addEffects,
    ],
  });
}
export const ExperienceRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(1600),
  mode: z.enum(["imagine", "history"]).default("imagine"),
  place: z.string().trim().max(120).default(""),
  period: z.string().trim().max(100).default(""),
  current: ScenePlanSchema.optional(),
});
export type ExperienceRequest = z.infer<typeof ExperienceRequestSchema>;
export interface ResearchSource {
  title: string;
  url: string;
  extract: string;
}
export interface ExperienceReply {
  limitations?: string[];
  context?: { mode: "imagine" | "history"; place: string; period: string };
  plan: ScenePlan;
  source: "ai" | "template";
  model?: string;
  latencyMs: number;
  sources: ResearchSource[];
  researchStatus: string;
  fallbackReason?: string;
  prompt: string;
}
export const SavedExperienceSchema = z.object({
  limitations: z.array(z.string().max(400)).max(16).optional(),
  context: z
    .object({
      mode: z.enum(["imagine", "history"]),
      place: z.string().max(120),
      period: z.string().max(100),
    })
    .optional(),
  plan: ScenePlanSchema,
  source: z.enum(["ai", "template"]),
  model: z.string().max(200).optional(),
  latencyMs: z.number().min(0),
  sources: z
    .array(
      z.object({
        title: z.string().max(180),
        url: z
          .string()
          .regex(/^https:\/\/en\.wikipedia\.org\/wiki\//)
          .max(1000),
        extract: z.string().max(1600),
      }),
    )
    .max(3),
  researchStatus: z.string().max(500),
  fallbackReason: z.string().max(500).optional(),
  prompt: z.string().max(1600),
});
export function isExperienceIntent(text: string) {
  // Keep established object commands in their current realm, even when the
  // placement mentions a village or garden. Whole-scene requests still compose.
  if (/^(create|build|generate|make|summon)\s+(?:(?:an?|the|huge|large|giant|small|tiny|glowing|red|blue|green|golden|stone|wooden)\s+)*(?:floating\s+island|castle|dragon|sword|orb|tower|tree|monolith|lantern|statue|bridge|crystal)\b/i.test(text)) return false;
  if (/^(create|build|generate|make)\b.*\b(garden|forest|ocean|city|civilization|cathedral|battlefield|palace|hall|village|world|environment|droplet|human eye|heat death)\b/i.test(text)) return true;
  return /\b(spell|fireball|waterbend|time travel|reconstruct|reconstruction)\b|^(imagine|experience|create a world|build a world)|^(cast|use|summon) (a |an )?(fire|water|ice|lightning|vortex|portal|steam)\b|\b(see|show|visit|take me).*(the past|ancient|prehistoric|\d+\s*(years? ago|bc|bce|ad|ce))\b/i.test(
    text,
  );
}

/** Authored demonstration, explicitly labelled as such whenever no model completes a plan. */
export function demoPlan(prompt = ""): ScenePlan {
  const water = /water|ocean|river/i.test(prompt),
    ice = /ice|snow|frozen/i.test(prompt);
  return {
    title: "Where the elements meet",
    description:
      "An old sanctuary, just after sunset. Aim water at the flame and watch it turn to steam. Describe a new world to reshape this place.",
    environment: {
      ground: ice ? "snow" : "stone",
      time: "blue",
      weather: "mist",
      sky: "#101e34",
      aurora: false,
    },
    objects: [
      ...[-1, 1].flatMap((side) =>
        [0, 1, 2].map((i) => ({
          kind: "column" as const,
          position: [side * (6 + i * 1.7), 0, -i * 6 - 3] as [
            number,
            number,
            number,
          ],
          scale: [1, 1.5 + i * 0.25, 1] as [number, number, number],
          color: "#b1b3aa",
          material: "stone" as const,
          motion: "still" as const,
        })),
      ),
      ...[-1, 1].flatMap((side) =>
        [0, 1, 2, 3].map((i) => ({
          kind: "tree" as const,
          position: [side * (14 + i * 3), 0, -12 - i * 8] as [
            number,
            number,
            number,
          ],
          scale: [1.4, 1.5 + i * 0.12, 1.4] as [number, number, number],
          color: "#527567",
          material: "wood" as const,
          motion: "still" as const,
        })),
      ),
      ...[-1, 1].flatMap((side) =>
        [0, 1, 2].map((i) => ({
          kind: "rock" as const,
          position: [side * (8 + i * 3), 0, -4 - i * 6] as [
            number,
            number,
            number,
          ],
          scale: [1.5, 0.8 + i * 0.2, 1.2] as [number, number, number],
          color: "#909b8e",
          material: "stone" as const,
          motion: "still" as const,
        })),
      ),
      {
        kind: "arch",
        position: [-1, 0, -24],
        rotation: -12,
        scale: [2.8, 2.8, 2],
        color: "#b6b9b1",
        material: "stone",
        motion: "still",
      },
      {
        kind: "firepit",
        position: [-2.5, 0, -5.5],
        scale: [1.2, 1.2, 1.2],
        color: "#969788",
        material: "stone",
        motion: "still",
      },
      {
        kind: "basin",
        position: [4, 0, -12],
        scale: [1.8, 1.8, 1.8],
        color: "#9dafa8",
        material: "stone",
        motion: "still",
      },
    ],
    effects: [
      {
        kind: ice ? "ice" : water ? "water" : "fire",
        position: [-2.5, 0.35, -5.5],
        size: 0.9,
        color: water ? "#63c6e8" : "#ff8a32",
      },
      { kind: "water", position: [4, 0.35, -12], size: 1.1, color: "#79aebb" },
      { kind: "fireflies", position: [0, 2, -12], size: 6, color: "#f7d7a0" },
    ],
    reconstruction: null,
  };
}
