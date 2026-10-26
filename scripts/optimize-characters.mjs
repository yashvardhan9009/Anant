import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
mkdirSync('.asset-cache/characters', { recursive: true });
for (const name of ['ilsa', 'doran', 'maera', 'seren']) {
  const output = `public/assets/characters/${name}.glb`, input = `.asset-cache/characters/${name}.glb`;
  if (!existsSync(input)) copyFileSync(output, input);
  execFileSync(process.execPath, ['node_modules/@gltf-transform/cli/bin/cli.js', 'optimize', input, output,
    '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '2048', '--simplify', 'false'], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`Optimized ${name}, preserving the rig and animation clips.`);
}
