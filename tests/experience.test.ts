import { describe, it, expect } from "vitest";
import {
  ScenePlanSchema,
  SavedExperienceSchema,
  ExperienceRequestSchema,
  demoPlan,
  isExperienceIntent,
  applySceneEdit,
  settleScene,
} from "../shared/experience";
import { castElement } from "../shared/elements";
import {
  composeExperience,
  researchPlace,
  sceneFormat,
} from "../server/experience";
import { NebiusClient, configFromEnv } from "../server/nebius";
import { Store } from "../server/db";
import { createWorld } from "../shared/worldState";

const request = ExperienceRequestSchema.parse({ prompt: "A water sanctuary" });
const json = (data: unknown) => new Response(JSON.stringify(data));
function local(content: string, calls: any[] = []) {
  return new NebiusClient(
    {
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      timeoutMs: 2000,
      model: "qwen3.5:9b",
    },
    (async (url: any, init: any) => {
      calls.push({ url, init });
      return String(url).endsWith("/api/tags")
        ? json({ models: [{ name: "qwen3.5:9b" }] })
        : json({ message: { content } });
    }) as typeof fetch,
  );
}
describe("Experience composition", () => {
  it("grounds unsupported static geometry while preserving supported and floating objects", () => {
    const plan = demoPlan();
    plan.objects = [
      {
        kind: "box",
        position: [0, 0, 0],
        scale: [1, 1, 1],
        color: "#aaaaaa",
        material: "stone",
        motion: "still",
      },
      {
        kind: "box",
        position: [0, 2, 0],
        scale: [1, 1, 1],
        color: "#aaaaaa",
        material: "stone",
        motion: "still",
      },
      {
        kind: "house",
        position: [15, 3, -20],
        scale: [1, 1, 1],
        color: "#aaaaaa",
        material: "stone",
        motion: "still",
      },
      {
        kind: "crystal",
        position: [5, 8, 0],
        scale: [1, 1, 1],
        color: "#aaffff",
        material: "glass",
        motion: "float",
      },
    ];
    const settled = settleScene(plan);
    expect(settled.objects.map((o) => o.position[1])).toEqual([0, 2, 0, 8]);
    expect(plan.objects[2].position[1]).toBe(3);
  });
  it("enforces render budgets, finite positions, safe colors, known scene types and prompt length", () => {
    expect(ScenePlanSchema.safeParse(demoPlan()).success).toBe(true);
    expect(
      ScenePlanSchema.safeParse({
        ...demoPlan(),
        effects: Array(13).fill(demoPlan().effects[0]),
      }).success,
    ).toBe(false);
    const bad = demoPlan();
    bad.objects[0].position[0] = Infinity;
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
    bad.objects[0].position[0] = 0;
    bad.objects[0].color = "url(javascript:alert(1))";
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
    expect(
      ExperienceRequestSchema.safeParse({ prompt: "x".repeat(1601) }).success,
    ).toBe(false);
  });
  it("uses installed local AI without credentials and disables reasoning / streaming", async () => {
    expect(
      configFromEnv({
        ANANT_AI_PROVIDER: "ollama",
        NEBIUS_API_KEY: "example-cloud-credential",
      }).apiKey,
    ).toBeUndefined();
    const calls: any[] = [];
    const reply = await composeExperience(
      request,
      local(JSON.stringify(demoPlan()), calls),
    );
    expect(reply.source).toBe("ai");
    expect(reply.model).toBe("qwen3.5:9b");
    const call = calls.find((c) => c.url.endsWith("/api/chat")),
      body = JSON.parse(call.init.body);
    expect(call.init.headers.Authorization).toBeUndefined();
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(JSON.stringify(body.format)).not.toContain("prefixItems");
    expect(body.format).toEqual(sceneFormat());
  });
  it("offline overrides local provider, no inference is falsely claimed", async () => {
    const cfg = configFromEnv({
      ANANT_AI_PROVIDER: "ollama",
      ANANT_OFFLINE: "1",
    });
    expect(new NebiusClient(cfg).enabled).toBe(false);
    const reply = await composeExperience(request, new NebiusClient(cfg));
    expect(reply.source).toBe("template");
    expect(reply.fallbackReason).toContain("not been generated");
  });
  it("preserves current scene on invalid AI output", async () => {
    const current = demoPlan("water");
    const reply = await composeExperience(
      { ...request, current },
      local('{"title":"Fake"}'),
    );
    expect(reply.source).toBe("template");
    expect(reply.plan).toEqual(current);
  });
  it("applies AI additions without changing unmentioned objects, environment or effects", async () => {
    const current = demoPlan(),
      effect = {
        kind: "portal" as const,
        position: [7, 0, -8] as [number, number, number],
        size: 1,
        color: "#ab88ff",
      };
    const edit = {
      title: "Portal garden",
      description: "A violet portal added.",
      environment: null,
      removeObjectIndices: [],
      addObjects: [],
      removeEffectIndices: [],
      addEffects: [effect],
    };
    const result = await composeExperience(
      { ...request, current },
      local(JSON.stringify(edit)),
    );
    expect(result.source).toBe("ai");
    expect(result.plan.objects).toEqual(current.objects);
    expect(result.plan.environment).toEqual(current.environment);
    expect(result.plan.effects).toEqual([...current.effects, effect]);
    expect(() =>
      applySceneEdit(current, { ...edit, removeEffectIndices: [11] }),
    ).toThrow("missing item");
  });
  it("forces a reconstruction label and uses only retrieved source links", async () => {
    const sources = [
      {
        title: "Rome",
        url: "https://en.wikipedia.org/wiki/Rome",
        extract: "Historical context",
      },
    ];
    const reply = await composeExperience(
      { ...request, mode: "history", place: "Rome", period: "100 CE" },
      local(JSON.stringify(demoPlan())),
      async () => sources,
    );
    expect(reply.plan.reconstruction?.interpretation).toContain("not verified");
    expect(reply.sources).toEqual(sources);
  });
  it("reports failed research and never fabricates citations", async () => {
    const reply = await composeExperience(
      { ...request, mode: "history", place: "Rome" },
      local(JSON.stringify(demoPlan())),
      async () => {
        throw Error("offline");
      },
    );
    expect(reply.sources).toEqual([]);
    expect(reply.researchStatus).toContain("unverified");
  });
  it("research stays on the fixed Wikipedia API and constructs links itself", async () => {
    const urls: string[] = [];
    const result = await researchPlace("https://evil.test", "past", (async (
      url: any,
    ) => {
      urls.push(String(url));
      return json({
        query: {
          pages: {
            1: {
              title: "A place",
              extract: "Historical information ".repeat(10),
              url: "https://evil.test",
            },
          },
        },
      });
    }) as typeof fetch);
    expect(
      urls.every((u) => u.startsWith("https://en.wikipedia.org/w/api.php?")),
    ).toBe(true);
    expect(result[0].url).toBe("https://en.wikipedia.org/wiki/A_place");
  });
  it("rejects unavailable configured local models without downloading", async () => {
    const llm = new NebiusClient(
      {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        model: "missing",
        timeoutMs: 100,
      },
      (async () => json({ models: [] })) as typeof fetch,
    );
    await expect(llm.resolveModel()).rejects.toThrow("not installed");
  });
  it("routes elemental and historical wishes without stealing existing navigation", () => {
    expect(isExperienceIntent("cast a water spell")).toBe(true);
    expect(isExperienceIntent("show me ancient Rome")).toBe(true);
    expect(isExperienceIntent("imagine a city in the clouds")).toBe(true);
    expect(isExperienceIntent("take me inside an atom")).toBe(false);
    expect(isExperienceIntent("show me a black hole")).toBe(false);
  });
});
describe("Element interactions and saves", () => {
  it("water extinguishes nearby fire, preserves distant effects and does not mutate input", () => {
    const plan = demoPlan(),
      before = structuredClone(plan);
    const result = castElement(plan, "water", [0, 0.1, -6]);
    expect(plan).toEqual(before);
    expect(result.plan.effects.some((e) => e.kind === "fire")).toBe(false);
    expect(result.plan.effects.some((e) => e.kind === "steam")).toBe(true);
    expect(result.plan.effects.some((e) => e.kind === "water")).toBe(true);
    expect(result.plan.effects.some((e) => e.kind === "fireflies")).toBe(true);
  });
  it("ice freezes water and fire melts ice with a bounded effect budget", () => {
    const initial = demoPlan("water");
    initial.effects = [
      { kind: "water", position: [0, 0.1, -6], size: 1, color: "#77ccee" },
    ];
    let plan = castElement(initial, "ice", [0, 0.1, -6]).plan;
    expect(plan.effects.some((e) => e.kind === "water")).toBe(false);
    plan = castElement(plan, "fire", [0, 0.1, -6]).plan;
    expect(plan.effects.some((e) => e.kind === "water")).toBe(true);
    for (let i = 0; i < 30; i++)
      plan = castElement(plan, "portal", [i, 0, 0]).plan;
    expect(plan.effects.length).toBeLessThanOrEqual(12);
  });
  it("persists generated scenes with a world and rejects unsafe stored citations", async () => {
    const reply = await composeExperience(
      request,
      local(JSON.stringify(demoPlan())),
    );
    expect(SavedExperienceSchema.safeParse(reply).success).toBe(true);
    const store = new Store(":memory:"),
      world = { ...createWorld(), experience: reply };
    expect(store.save(world).ok).toBe(true);
    expect(store.load(world.id).experience).toEqual(reply);
    reply.sources = [
      { title: "bad", url: "javascript:alert(1)", extract: "bad" },
    ];
    expect(store.save({ ...world, experience: reply }).ok).toBe(false);
    store.close();
  });
});
