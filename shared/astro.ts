/** Named astronomical objects (metadata shared by the reducer, the parser and the renderer). */
import OBJECTS from './astroObjects.json';

export interface AstroObject {
  id: string;
  name: string;
  aliases: string[];
  simbad: string;
  d_pc?: number;
  d_mpc?: number;
  ref: string;
  kind: string;
  size_kpc: number;
  where?: 'milky_way';
  images?: string[];
  jwst?: boolean;
}

export const ASTRO: AstroObject[] = OBJECTS as AstroObject[];
const PC = 3.0857e16;

export const distanceM = (o: AstroObject) => (o.d_pc !== undefined ? o.d_pc * PC : (o.d_mpc ?? 0) * 1e6 * PC);
export const inMilkyWay = (o: AstroObject) => o.where === 'milky_way';

/** Observer size used to frame an object: a few times its physical size. */
export const viewSizeFor = (o: AstroObject) => Math.max(o.size_kpc * 1000 * PC * 4, 3e17);

export function resolveAstro(q: string): AstroObject | undefined {
  const t = q.toLowerCase().replace(/^the\s+/, '').replace(/[’']/g, "'").trim();
  if (!t) return undefined;
  return (
    ASTRO.find((o) => o.id === t || o.name.toLowerCase() === t) ??
    ASTRO.find((o) => o.aliases.some((a) => a === t)) ??
    ASTRO.find((o) => o.aliases.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))) ??
    ASTRO.find((o) => o.name.toLowerCase().includes(t))
  );
}

export function formatDistance(o: AstroObject) {
  if (o.d_pc !== undefined) return o.d_pc >= 1000 ? `${(o.d_pc * 3.2616 / 1000).toPrecision(3)} thousand light-years` : `${Math.round(o.d_pc * 3.2616).toLocaleString()} light-years`;
  const mly = (o.d_mpc ?? 0) * 3.2616;
  return mly >= 1000 ? `${(mly / 1000).toPrecision(3)} billion light-years` : `${mly.toPrecision(3)} million light-years`;
}
