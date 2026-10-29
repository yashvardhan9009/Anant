import { Credit, CustomHeightmapTerrainProvider, WebMercatorTilingScheme } from 'cesium';

/** Terrarium encodes signed elevation in metres, including ocean depths. */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

export function resampleHeights(rgba: Uint8ClampedArray, size = 256, grid = 65) {
  const result = new Float32Array(grid * grid);
  const at = (x: number, y: number) => {
    const i = (Math.min(size - 1, y) * size + Math.min(size - 1, x)) * 4;
    return Math.max(0, terrariumHeight(rgba[i], rgba[i + 1], rgba[i + 2]));
  };
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
    const sx = x * (size - 1) / (grid - 1), sy = y * (size - 1) / (grid - 1);
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    result[y * grid + x] = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy)
      + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  }
  return result;
}

export function publicTerrain(onFailure: () => void) {
  const controller = new AbortController();
  let active = 0;
  const cache = new Map<string, Float32Array>();
  const provider = new CustomHeightmapTerrainProvider({
    width: 65, height: 65, tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit('Terrain: <a href="https://www.mapzen.com/rights/">Mapzen / USGS / SRTM and contributors</a>', true),
    callback(x, y, level) {
      if (level < 3) return new Float32Array(65 * 65);
      const key = `${level}/${x}/${y}`;
      if (cache.has(key)) return cache.get(key)!;
      if (active >= 8 || controller.signal.aborted) return undefined;
      active++;
      return fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`, { signal: controller.signal })
        .then(async r => {
          if (!r.ok) throw new Error('Terrain unavailable');
          const bitmap = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none' });
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 256;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(bitmap, 0, 0); bitmap.close();
          const heights = resampleHeights(ctx.getImageData(0, 0, 256, 256).data);
          cache.set(key, heights);
          if (cache.size > 192) cache.delete(cache.keys().next().value!);
          return heights;
        }).catch(e => { if (!controller.signal.aborted) onFailure(); throw e; })
        .finally(() => active--);
    },
  });
  // Above the source resolution Cesium upsamples the parent geometry; imagery can
  // continue refining independently. Never request nonexistent high-zoom DEM tiles.
  provider.getTileDataAvailable = (_x, _y, level) => level <= 14;
  return { provider, dispose: () => { controller.abort(); cache.clear(); } };
}
