# Rebuilding the village characters

The four character GLBs are generated assets, not runtime dependencies on a
character-generation service. Each model's complete inputs are saved beside it
in `public/assets/characters/*.params.json`.

Generator: [3d-gen](https://github.com/olatunde85/3d-gen) at
`0c3473d7d46a2badcdcd1dcfd4aeb0762eb04b20`; MakeHuman source at
`a8bc2d54ff0ac92e78ff71431b1023eda42bf482`. Use the generator's asset setup and
CLI exporter with each params file, retaining only the `idle` and `walk` clips
in its export settings. Export GLB in metres, game skeleton, high detail,
no facial morph targets. On Windows the generator's asset builder must normalize
relative target paths to forward slashes before matching target names.

Copy the uncompressed GLBs to `public/assets/characters/`, then run
`node scripts/optimize-characters.mjs`. It retains the source copies under
`.asset-cache/characters/` and compresses geometry with meshoptimizer and
textures with WebP, without simplifying facial geometry or removing the rig.
The asset script's Sharp override fixes the native image-encoder incompatibility
encountered on Windows with the older transitive dependency.

MakeHuman meshes and appearance assets are CC0. Walking includes CMU motion
capture; see the adjacent `LICENSE.txt` for the required acknowledgement and
source terms. The game applies positioning, cross-fading and walking speed at
runtime; story, relationships and dialogue continue to use existing NPC IDs.
