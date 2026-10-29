import { type EffectKind, type ScenePlan } from "./experience";
const colors: Record<EffectKind, string> = {
  fire: "#ff7722",
  water: "#73cff6",
  ice: "#b6eaff",
  lightning: "#c0baff",
  vortex: "#a7a6bd",
  portal: "#9f80ff",
  fireflies: "#f5dd9a",
  steam: "#d2e0e7",
};
export function castElement(
  plan: ScenePlan,
  kind: EffectKind,
  point: [number, number, number],
): { plan: ScenePlan; message: string } {
  const next = structuredClone(plan);
  const at = point.map((v, i) =>
    Math.min(i === 1 ? 60 : 100, Math.max(i === 1 ? 0 : -100, v)),
  ) as typeof point;
  let interaction = "";
  next.effects = next.effects.flatMap((effect) => {
    if (
      Math.hypot(
        effect.position[0] - at[0],
        effect.position[1] - at[1],
        effect.position[2] - at[2],
      ) >
      effect.size + 2
    )
      return [effect];
    if (
      (kind === "water" && effect.kind === "fire") ||
      (kind === "fire" && effect.kind === "water")
    ) {
      interaction =
        "Water meets fire: the flame subsides into a plume of steam.";
      return [{ ...effect, kind: "steam" as const, color: colors.steam }];
    }
    if (kind === "ice" && effect.kind === "water") {
      interaction = "The water crystallizes into ice.";
      return [];
    }
    if (kind === "fire" && effect.kind === "ice") {
      interaction = "Heat melts the ice into water.";
      return [{ ...effect, kind: "water" as const, color: colors.water }];
    }
    return [effect];
  });
  // An extinguished fire does not reignite in the same cast.
  if (!(interaction.startsWith("Water meets") && kind === "fire"))
    next.effects.push({ kind, position: at, size: 1.6, color: colors[kind] });
  next.effects = next.effects.slice(-12);
  return {
    plan: next,
    message:
      interaction ||
      `${kind[0].toUpperCase() + kind.slice(1)} manifested. Aim at another location to cast again.`,
  };
}
