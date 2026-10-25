// Downloads the MediaPipe hand landmark model (Apache-2.0) into public/models.
// If this fails the client falls back to loading it from Google's CDN at runtime.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const url = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const out = 'public/models/hand_landmarker.task';
if (!existsSync(out)) {
  try {
    mkdirSync('public/models', { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log('[anant] downloaded hand_landmarker.task');
  } catch (e) {
    console.warn('[anant] could not download hand model (runtime CDN fallback will be used):', e.message);
  }
}
