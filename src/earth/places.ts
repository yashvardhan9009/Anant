export interface Place { name: string; lon: number; lat: number; range: number; pitch?: number; elevation?: number }
export const DESTINATIONS: Place[] = [
  { name: 'Earth', lon: 78, lat: 18, range: 18000000, pitch: -90 },
  { name: 'Himalayas', lon: 86.925, lat: 27.988, range: 20000, elevation: 7200, pitch: -18 },
  { name: 'Grand Canyon', lon: -112.12, lat: 36.10, range: 9500, elevation: 1200, pitch: -17 },
  { name: 'New York', lon: -73.975, lat: 40.768, range: 4200, pitch: -65 },
  { name: 'Mumbai', lon: 72.83, lat: 18.94, range: 6500, pitch: -60 },
  { name: 'Swiss Alps', lon: 7.6586, lat: 45.9763, range: 13000, elevation: 3000, pitch: -18 },
];
export function parseCoordinates(query: string): Place | undefined {
  const m = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return;
  return { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, range: 8000, pitch: -60 };
}
