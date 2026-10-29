// CC0 source maps; new versioned filenames leave deployed low-tier caches intact.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
const ids = [
  "cobblestone_floor_01",
  "forest_ground_04",
  "leafy_grass",
  "plastered_wall_02",
  "weathered_planks",
  "stone_wall_04",
  "mossy_rock",
  "clay_roof_tiles_02",
  "roof_slates_02",
  "sand_01",
  "snow_02",
];
const cache = ".asset-cache/detail-v1",
  out = "public/assets/detail-v1";
mkdirSync(cache, { recursive: true });
const curl = (url, dest) =>
  execFileSync(
    process.platform === "win32" ? "curl.exe" : "curl",
    ["-sSfL", "--retry", "3", "--max-time", "90", url, "-o", dest],
    { stdio: "inherit" },
  );
const sources = {};
for (const id of ids) {
  const meta = join(cache, id + ".json");
  if (!existsSync(meta)) curl("https://api.polyhaven.com/files/" + id, meta);
  const data = JSON.parse(readFileSync(meta));
  const dir = join(out, id);
  mkdirSync(dir, { recursive: true });
  sources[id] = {};
  if (["sand_01", "snow_02"].includes(id)) {
    const lowDir = join("public/assets/textures", id);
    mkdirSync(lowDir, { recursive: true });
    for (const [name, type] of [
      ["diff", "Diffuse"],
      ["nor", "nor_gl"],
      ["arm", "arm"],
    ]) {
      const dest = join(lowDir, name + ".jpg");
      if (!existsSync(dest)) curl(data[type]["1k"].jpg.url, dest);
    }
  }
  for (const [name, type] of [
    ["diff", "Diffuse"],
    ["nor", "nor_gl"],
    ["arm", "arm"],
    ["height", "Displacement"],
  ]) {
    const source = data[type]?.["2k"]?.[name === "height" ? "png" : "jpg"];
    if (!source) continue;
    const dest = join(dir, name + ".webp");
    if (!existsSync(dest) || process.argv.includes("--reencode")) {
      const input = join(
        cache,
        id + "-" + name + (name === "height" ? ".png" : ".jpg"),
      );
      if (!existsSync(input)) curl(source.url, input);
      // Displacement remains lossless at 8-bit precision. Normal maps use high
      // quality encoding from the already-JPEG source, instead of a much larger
      // lossless copy of those JPEG pixels. Never derive height from albedo.
      await sharp(input)
        .resize(2048, 2048, { fit: "fill" })
        .webp({
          lossless: name === "height",
          quality: name === "nor" ? 97 : name === "diff" ? 92 : 95,
          effort: 5,
        })
        .toFile(dest);
    }
    sources[id][name] = {
      source: source.url,
      sourceMD5: source.md5,
      sha256: createHash("sha256").update(readFileSync(dest)).digest("hex"),
    };
  }
  console.log("[detail]", id, Object.keys(sources[id]).join(", "));
}
writeFileSync(
  join(out, "sources.json"),
  JSON.stringify(
    { license: "CC0 1.0", provider: "Poly Haven", surfaces: sources },
    null,
    2,
  ) + "\n",
);
const manifestPath = "public/assets/manifest.json",
  manifest = JSON.parse(readFileSync(manifestPath));
manifest.detail = Object.fromEntries(
  Object.entries(sources).map(([id, maps]) => [id, Object.keys(maps)]),
);
manifest.textures = [...new Set([...manifest.textures, ...ids])];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const creditsPath = "public/assets/CREDITS.json",
  credits = JSON.parse(readFileSync(creditsPath));
for (const id of ["sand_01", "snow_02"])
  if (!credits[id]) {
    const meta = join(cache, id + "-info.json");
    if (!existsSync(meta)) curl("https://api.polyhaven.com/info/" + id, meta);
    const info = JSON.parse(readFileSync(meta));
    credits[id] = {
      name: info.name,
      type: "texture",
      authors: Object.keys(info.authors ?? {}),
      license: "CC0 1.0",
      source: "https://polyhaven.com/a/" + id,
    };
  }
writeFileSync(creditsPath, JSON.stringify(credits, null, 2) + "\n");
