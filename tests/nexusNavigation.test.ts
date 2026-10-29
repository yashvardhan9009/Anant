import { describe, it, expect } from "vitest";
import {
  NEXUS_GATES,
  GATE_STEPS,
  gateYaw,
  nexusGroundHeight,
} from "../src/realms/nexusLayout";

describe("Nexus walkable construction", () => {
  it("grounds the dais, each step and the surrounding floor at their built heights", () => {
    expect(nexusGroundHeight(0, -2)).toBe(0.48);
    expect(nexusGroundHeight(5.5, -2)).toBe(0.32);
    expect(nexusGroundHeight(5.8, -2)).toBe(0.18);
    expect(nexusGroundHeight(0, 10)).toBe(0);
  });
  it.each(NEXUS_GATES)(
    "%s has an accessible, correctly rotated staircase",
    (_id, _title, x, z) => {
      const a = gateYaw(x, z),
        world = (lx: number, lz: number) =>
          [
            x + Math.cos(a) * lx + Math.sin(a) * lz,
            z - Math.sin(a) * lx + Math.cos(a) * lz,
          ] as const;
      for (let i = 0; i < GATE_STEPS.length; i++) {
        const step = GATE_STEPS[i],
          p = world(0, step.z + step.depth / 2 - 0.06);
        expect(nexusGroundHeight(...p)).toBeCloseTo(step.height);
      }
      const landing = world(0, 5.2);
      expect(nexusGroundHeight(...landing)).toBe(0);
    },
  );
});
