/** Requested behaviours which the compositional Studio cannot execute. These
 * are engine facts, rather than another model's judgement of its own output. */
export function sceneLimitations(prompt: string): string[] {
  const text = prompt.toLowerCase(),
    limits: string[] = [];
  const check = (pattern: RegExp, message: string) => {
    if (pattern.test(text)) limits.push(message);
  };
  check(
    /shrink|miniature civilization|nested|another universe|galaxy within|inside (?:a |the )?(?:droplet|eye)/,
    "Continuous shrinking and nested, enterable worlds are unavailable in the Studio.",
  );
  check(
    /real ocean|marine life|swim|fluid|enormous droplets|rivers carving|oceans spreading/,
    "Water is an animated visual effect. Swimming, buoyancy, marine life and fluid flow are unavailable.",
  );
  check(
    /walking.*tree|trees?.*(?:walking|communicat|reacting)|branches.*toward|touch.*tree|glowing roots/,
    "Trees have wind animation; they cannot walk, sense touch or communicate with one another.",
  );
  check(
    /non.euclidean|impossible staircase|returns? to (?:its|the) starting|without teleportation/,
    "Continuous non-Euclidean rooms and looping walkable staircases are unavailable.",
  );
  check(
    /black\s*hole|gravitational lensing|distorted surroundings/,
    "The Studio cannot lens a garden or its reflections. Black-hole ray integration is available only in the dedicated Cosmos view.",
  );
  check(
    /time.*regions|regions.*time|time.*backward|run backward|independent.*clocks/,
    "Objects share one simulation clock. Independent time regions and reverse simulation are unavailable.",
  );
  check(
    /mirrors?|recursiv.*reflect/,
    "A bounded water reflection is supported. Recursive mirror halls and walk-through mirror portals are unavailable.",
  );
  check(
    /million years|mountains forming|civilizations constructing|vegetation emerging|planet.*builds/,
    "Terrain, ecosystems and civilizations do not evolve over geological time.",
  );
  check(
    /kilometers? wide|kilometres? wide|moving surfaces|rotating machinery|moving reference/,
    "Walkable rotating reference frames and city-scale mechanical simulations are unavailable.",
  );
  check(
    /human eye|realistic.*eye/,
    "There is no anatomical human-eye asset. A sphere cannot reproduce realistic eye anatomy.",
  );
  check(
    /four.dimensional|tesseract|three.dimensional cross.section|4d/,
    "Four-dimensional geometry, tesseract projections and changing spatial cross-sections are unavailable.",
  );
  check(
    /heat death|stars exhausting|reverse time|different epochs/,
    "Stellar evolution, heat death and reversible cosmic epochs are unavailable.",
  );
  check(
    /inhabitants|personalit|relationships|personal goals|collectively dreams|simulated internal states|future dreams/,
    "The Studio cannot simulate inhabitants, their memories or a world generated from their dreams.",
  );
  check(
    /stars.*imitate|stars.*rearrange|universe.*neuron|looks back/,
    "Camera-aware or hand-controlled stellar formations and nested simulated beings are unavailable.",
  );
  if (/500\s*(?:m\b|meters|metres)|kilomet|kilometer/.test(text))
    limits.push(
      "The Studio is a bounded scene; kilometre-scale streamed environments are unavailable.",
    );
  return limits;
}
