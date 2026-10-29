# Rendering target

Photorealism is the project's visual objective. Judge it from actual application
captures, including close surfaces and motion. Better lighting and assets must
carry the image; bloom, sharpening and saturated grading must not hide defects.

The reference laptop has an RTX 5050 Laptop GPU with 8 GB VRAM and 24 GB system
memory. Preserve the existing WebGL2 renderer and deterministic world systems.
Prioritize accurate material scale, authored anatomy/animation, geometric relief,
HDR image-based lighting, shadows, and convincing interactions before adding
expensive effects. Keep the scientific models and artistic approximations labelled.

## Current paths

- Performance: reduced pixel density, no shadow maps, contact AO or planar water
  reflections. Balanced retains lighting/shadows with reduced portal resolution.
- Cinematic: 2048 shadows, HDR multisampling, contact shading, photographic skies,
  detailed local assets and bounded reflections. Portal previews reuse shadow maps.
- Ultra: 4096 shadows, higher-resolution portals and water reflection targets, and
  up to 2× pixel density in Studio. It is an optional higher-cost path, not a claim
  that it sustains 60 fps on this laptop.

Assets stream on demand; trees and dressing use instances and distant projections.
The Nexus merges static architectural detail by material and instances its floor
slabs and fragments. A single wet-floor capture runs at 12 Hz / 768 pixels in
Cinematic, 24 Hz / 1536 in Ultra, and 12 Hz / 384 in Balanced; Performance omits
it. The static hall reuses its shadow map, enabling dynamic updates while user
objects are present. Camera-dependent aperture clipping also applies inside
the floor reflection. Vignette geometry is excluded from the AO override pass,
which cannot reproduce its custom clipping. Circular hit areas prevent invisible
background planes from intercepting selection. The destination imagery remains
an artistic vignette; selecting it opens the existing interactive realm.
The dragon keeps the source's authored mesh, normal maps, skeleton and motion.
Its source is pinned and reproducible with `node scripts/fetch-creatures.mjs`.

Local AI and rendering share the same GPU memory. Ollama now releases its model
after each completed request by default (`OLLAMA_KEEP_ALIVE=0`). Setting `5m`
keeps it resident for faster repeated prompts, with substantially less graphics
headroom. On the reference laptop a measured idle sample fell from 7199 MiB to
1449 MiB after release. That is a memory measurement, not an RTX rendering benchmark.

## Honesty and practical boundaries

The current engine uses rasterized direct lighting, image-based ambient lighting
and screen-space contact shading. It does not implement path-traced GI, hardware
RTX ray tracing, DLSS, or motion-vector temporal reconstruction. The black-hole
view integrates rays in a Schwarzschild model; that does not provide general
scene ray tracing. Any future tracing path should be optional, use a bounded
scene/texture budget, release its resources, and retain the working interactive path.

AI scene composition returns a bounded kit (60 objects, 12 effects). Generated
JSON and prose cannot create new engine capabilities. Unsupported requested
behaviours must be stated explicitly; never present valid JSON or a rendered
approximation as a successful physics or interaction test. Historical scenes
remain artistic interpretations with contextual references.

Run TypeScript, unit tests, the cinematic gameplay regression and the focused
realism browser checks. Record the browser's actual adapter, dimensions and FPS.
The automated Chromium runs on this Windows machine currently select Intel
integrated graphics, despite requesting high performance; do not label those
measurements RTX 5050 results. Inspect captures before claiming a visual improvement.
