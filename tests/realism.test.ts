import { describe, it, expect } from "vitest";
import { direct } from "../server/director";
import { NebiusClient } from "../server/nebius";
import { createWorld, execute } from "../shared/worldState";
import { parseIntent } from "../shared/localParser";
import { sceneLimitations } from "../shared/sceneCapabilities";
import {
  isExperienceIntent,
  SavedExperienceSchema,
  demoPlan,
} from "../shared/experience";

const world = () =>
  execute(createWorld(), { op: "go_to_realm", realm: "cosmos" }).state;
function ai(replies: any[]) {
  let count = 0;
  const client = new NebiusClient(
    {
      provider: "ollama",
      baseUrl: "http://local.test",
      model: "test",
      timeoutMs: 2000,
    },
    (async (url: any) => {
      if (String(url).endsWith("/api/tags"))
        return new Response(JSON.stringify({ models: [{ name: "test" }] }));
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify(
              replies[Math.min(count++, replies.length - 1)],
            ),
          },
        }),
      );
    }) as any,
  );
  return { client, calls: () => count };
}
describe("requested behaviour and command recovery", () => {
  it("repairs a scalar celestial position before returning any action", async () => {
    const { client, calls } = ai([
      {
        commands: [{ op: "cosmos_move_body", target: "earth", position: 0.3 }],
      },
      {
        commands: [
          { op: "cosmos_move_body", target: "earth", position: [0.3, 0, 0] },
        ],
      },
    ]);
    const reply = await direct(
      "put Earth at x=0.3 AU, y=0, z=0",
      world(),
      client,
    );
    expect(calls()).toBe(2);
    expect(reply.issues).toEqual([]);
    expect(reply.commands).toEqual([
      { op: "cosmos_move_body", target: "earth", position: [0.3, 0, 0] },
    ]);
  });
  it("uses a complete deterministic plan if the model repeatedly returns bad vectors", async () => {
    const { client, calls } = ai([
      {
        commands: [
          { op: "cosmos_set_mode", mode: "sandbox" },
          { op: "cosmos_move_body", target: "earth", position: 0.3 },
        ],
      },
    ]);
    const reply = await direct("move Earth closer to the Sun", world(), client);
    expect(calls()).toBe(2);
    expect(reply.source).toBe("local-parser");
    expect(reply.commands).toContainEqual({
      op: "cosmos_move_body",
      target: "earth",
      toward: "sun",
      fraction: 0.4,
    });
  });
  it("does not apply only a mode change when the requested action is invalid", async () => {
    const { client } = ai([
      {
        commands: [
          { op: "cosmos_set_mode", mode: "sandbox" },
          { op: "cosmos_move_body", target: "earth", position: 0.3 },
        ],
      },
    ]);
    const reply = await direct(
      "arrange these according to my unpublished diagram",
      world(),
      client,
    );
    expect(reply.commands).toEqual([]);
    expect(reply.issues).not.toHaveLength(0);
  });
  it("moves a companion in the black-hole view instead of a hidden solar-system body", async () => {
    const before = world(),
      earth = structuredClone(
        before.cosmos.bodies.find((b) => b.id === "earth"),
      );
    const { client, calls } = ai([]);
    const reply = await direct("bring earth near blackhole", before, client);
    expect(calls()).toBe(0);
    let state = before;
    for (const cmd of reply.commands) {
      const next = execute(state, cmd);
      expect(next.result.ok).toBe(true);
      state = next.state;
    }
    expect(state.cosmos.blackHoleCompanion).toEqual({
      bodyId: "earth",
      distanceRs: 22,
    });
    expect(state.cosmos.bodies.find((b) => b.id === "earth")).toEqual(earth);
    const closer = parseIntent("bring it closer", state);
    expect(closer.commands).toContainEqual({
      op: "cosmos_black_hole",
      show: true,
      distance_rs: 15.399999999999999,
    });
  });
  it("reports missing behaviours independently of what the model claims", () => {
    expect(
      sceneLimitations(
        "Shrink continuously, enter the droplet and walk through its miniature civilization",
      ),
    ).toContain(
      "Continuous shrinking and nested, enterable worlds are unavailable in the Studio.",
    );
    expect(
      sceneLimitations(
        "A garden with gravitational lensing reflected in a pond",
      ),
    ).toHaveLength(1);
    expect(
      sceneLimitations(
        "An extremely realistic human eye, with another universe inside",
      ),
    ).toHaveLength(2);
    expect(
      sceneLimitations("A stone sanctuary with a fountain and fireflies"),
    ).toEqual([]);
  });
  it("routes compositional requests to Studio while retaining existing single-object commands", () => {
    for (const input of [
      "Create a single realistic water droplet floating in the air",
      "Create a peaceful Japanese garden",
      "Create an extremely realistic human eye",
    ])
      expect(isExperienceIntent(input)).toBe(true);
    for (const input of [
      "Summon a dragon",
      "Create a castle",
      "Create a floating island above the village and put a castle on it",
      "Create a miniature solar system",
      "bring Earth near blackhole",
    ])
      expect(isExperienceIntent(input)).toBe(false);
  });
  it("keeps capability notes through saved-world validation", () => {
    const saved = SavedExperienceSchema.parse({
      plan: demoPlan(),
      source: "ai",
      latencyMs: 1,
      sources: [],
      researchStatus: "",
      prompt: "droplet",
      limitations: sceneLimitations("shrink and enter a droplet"),
    });
    expect(saved.limitations).toHaveLength(1);
  });
});
