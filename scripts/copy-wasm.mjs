// Copies MediaPipe's WASM runtime into public/ so hand tracking works offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'public/mediapipe';
if (existsSync(src)) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log('[anant] copied MediaPipe wasm -> public/mediapipe');
}
