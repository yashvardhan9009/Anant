import { cp, mkdir } from 'node:fs/promises';
// Workers and their imported modules must remain at stable URLs, outside Vite's bundle.
await mkdir('public/cesium', { recursive: true });
for (const dir of ['Workers', 'Assets', 'ThirdParty', 'Widgets']) {
  await cp(`node_modules/cesium/Build/Cesium/${dir}`, `public/cesium/${dir}`, { recursive: true });
}
