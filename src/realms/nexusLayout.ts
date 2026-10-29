import type { RealmId } from "../../shared/commands";

/** Construction and navigation share these dimensions (metres). */
export const NEXUS_GATES: [RealmId, string, number, number, string][] = [
  ["atom", "THE QUANTUM REALM", -22, -11, "#76bfff"],
  ["heavy", "HYPOTHETICAL · HEAVY GRAVITY", -8.2, -18, "#a3b8ff"],
  ["village", "EMBERFALL · LIVING STORY", 8.2, -18, "#ffd0a1"],
  ["cosmos", "THE COSMOS", 22, -11, "#ffb567"],
];
export const GATE_STEPS = Array.from({ length: 5 }, (_, i) => ({
  width: 15 - i * 0.6,
  depth: 4.6 - i * 0.6,
  height: (i + 1) * 0.18,
  z: 1.2,
}));
export const gateYaw = (x: number, z: number) => Math.atan2(-x, 22 - z);
export function nexusGroundHeight(x: number, z: number) {
  const r = Math.hypot(x, z + 2);
  let height = r < 5.4 ? 0.48 : r < 5.7 ? 0.32 : r < 6 ? 0.18 : 0;
  for (const [, , gx, gz] of NEXUS_GATES) {
    const a = gateYaw(gx, gz),
      c = Math.cos(a),
      s = Math.sin(a),
      dx = x - gx,
      dz = z - gz;
    const lx = dx * c - dz * s,
      lz = dx * s + dz * c;
    for (const step of GATE_STEPS)
      if (
        Math.abs(lx) <= step.width / 2 &&
        Math.abs(lz - step.z) <= step.depth / 2
      )
        height = Math.max(height, step.height);
  }
  return height;
}
