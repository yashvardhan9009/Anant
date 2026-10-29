// Reproduce the shipped CC BY dragon without downloading or running scripts
// from the model's source repository. The original byte hash is pinned.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = ".asset-cache/creatures";
mkdirSync(dir, { recursive: true });
mkdirSync("public/assets/creatures", { recursive: true });
const source = dir + "/animated-dragon.glb",
  converted = dir + "/dragon-pbr.glb";
execFileSync(
  "curl",
  [
    "-sSfL",
    "--retry",
    "3",
    "-o",
    source,
    "https://raw.githubusercontent.com/sceneview/sceneview/6f4796fbb30d6e59ba1a3dca8fe30693deb5bbb3/samples/web-demo/site/models/animated_dragon.glb",
  ],
  { stdio: "inherit", windowsHide: true },
);
if (
  createHash("sha256").update(readFileSync(source)).digest("hex") !==
  "3c0de20bd73179603b7a089f370420ed8f429c15bf8ec67afb378d1121ed2e40"
)
  throw Error("Creature source hash mismatch");
const cli = "node_modules/@gltf-transform/cli/bin/cli.js";
execFileSync(process.execPath, [cli, "metalrough", source, converted], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(
  process.execPath,
  [
    cli,
    "optimize",
    converted,
    "public/assets/creatures/dragon-flight.glb",
    "--compress",
    "meshopt",
    "--texture-compress",
    "webp",
    "--texture-size",
    "2048",
    "--simplify",
    "false",
  ],
  { stdio: "inherit", windowsHide: true },
);
console.log(
  "Dragon rebuilt. Attribution: public/assets/CREDITS.json · LasquetiSpice · CC BY 4.0.",
);
