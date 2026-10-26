/** Fixed-source public imagery relay with a bounded memory cache. Requests carry
 * only tile coordinates; no API key, address search or user identifier is sent. */
export function validEarthTile(z: number, x: number, y: number) {
  return [z, x, y].every(Number.isInteger) && z >= 0 && z <= 14 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}
const cache = new Map<string, Buffer>();
const pending = new Map<string, Promise<Buffer>>();
let bytes = 0;
export async function earthImagery(z: number, x: number, y: number) {
  if (!validEarthTile(z, x, y)) throw Object.assign(new Error('Invalid Earth tile'), { status: 400 });
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) {
    const image = cache.get(key)!; cache.delete(key); cache.set(key, image); return image;
  }
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 12) throw Object.assign(new Error('Earth imagery is busy; retry shortly'), { status: 503 });
  const task = (async () => {
    const r = await fetch(`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`, { signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!r.ok || !r.headers.get('content-type')?.startsWith('image/jpeg')) throw Object.assign(new Error('Earth imagery unavailable'), { status: 502 });
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = r.body!.getReader();
    try { while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 1_000_000) throw Object.assign(new Error('Invalid imagery response'), { status: 502 });
      chunks.push(value);
    } } finally { await reader.cancel(); }
    const image = Buffer.concat(chunks); cache.set(key, image); bytes += image.length;
    while (bytes > 16_000_000) { const oldest = cache.keys().next().value!; bytes -= cache.get(oldest)!.length; cache.delete(oldest); }
    return image;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
