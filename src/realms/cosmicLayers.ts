/**
 * Cosmic layers beyond the solar system. Each layer has its own units so
 * astronomical distances never share one low-precision coordinate system:
 *   • MilkyWayModel — 1 unit = 100 pc, the Sun at the origin
 *   • GalaxyField   — 1 unit = 1 Mpc, the Milky Way at the origin
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { QUALITY } from '../engine/quality';

export interface CatalogEntry {
  id: string; name: string; kind: string; ref: string; ra: number; dec: number; l: number; b: number;
  d_pc?: number; d_mpc?: number; size_kpc: number; where?: string; jwst?: boolean; simbadType?: string;
  images: { file: string; title: string; credit: string; telescope: string; page: string; license: string }[];
}

const D2R = Math.PI / 180;
export const SUN_R_KPC = 8.178; // GRAVITY Collaboration 2019

/** heliocentric galactic (l, b, d) → scene axes (x toward the Galactic Centre, y north, z toward l = 90°) */
export function galacticXYZ(l: number, b: number, d: number) {
  const cb = Math.cos(b * D2R);
  return new THREE.Vector3(d * cb * Math.cos(l * D2R), d * Math.sin(b * D2R), d * cb * Math.sin(l * D2R));
}

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const POINT_VS = /* glsl */ `
  attribute float size; attribute vec3 color; uniform float uProj, uOpacity, uMin, uMax; varying vec3 vC; varying float vA;
  void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
    float px = size * uProj / -mv.z; gl_PointSize = clamp(px, uMin, uMax);
    vC = color; vA = uOpacity * clamp(px / uMin, 0.25, 1.0); }`;
const POINT_FS = /* glsl */ `
  varying vec3 vC; varying float vA; uniform float uDark;
  void main(){ vec2 q = gl_PointCoord - 0.5; float a = exp(-dot(q, q) * 14.0);
    if (uDark > 0.5) gl_FragColor = vec4(vec3(0.0), a * vA * 0.5); else gl_FragColor = vec4(vC * a * vA, a * vA); }`;

function pointsMaterial(dark = false, min = 1.0, max = 24) {
  return new THREE.ShaderMaterial({
    uniforms: { uProj: { value: 600 }, uOpacity: { value: 1 }, uMin: { value: min }, uMax: { value: max }, uDark: { value: dark ? 1 : 0 } },
    vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false,
    blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

/** A soft, round, procedural galaxy image for objects without telescope imagery (labelled RECONSTRUCTED). */
export function proceduralGalaxyTexture(kind: 'spiral' | 'elliptical', seed = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const core = g.createRadialGradient(128, 128, 0, 128, 128, kind === 'elliptical' ? 120 : 40);
  core.addColorStop(0, 'rgba(255,240,215,1)');
  core.addColorStop(1, 'rgba(255,220,180,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, 256, 256);
  if (kind === 'spiral') {
    for (let i = 0; i < 2600; i++) {
      const arm = i % 2, t = r() * 3.2;
      const rad = 10 + t * 34, a = arm * Math.PI + t * 1.6 + (r() - 0.5) * 0.5;
      g.fillStyle = `rgba(${170 + r() * 60},${190 + r() * 50},255,${0.25 * (1 - t / 3.4)})`;
      g.fillRect(128 + Math.cos(a) * rad, 128 + Math.sin(a) * rad, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Image impostor: a telescope image on a soft-edged disc that faces the camera. */
function impostor(tex: THREE.Texture, size: number) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: tex }, uOpacity: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * vec2(length(modelMatrix[0].xyz)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; uniform float uOpacity; varying vec2 vUv; void main(){ vec2 q = vUv - 0.5; float edge = smoothstep(0.5, 0.36, length(q)); vec3 c = texture2D(uMap, vUv).rgb; gl_FragColor = vec4(c * edge * uOpacity * 1.2, edge * uOpacity); }`,
  });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  p.scale.setScalar(size);
  p.frustumCulled = false;
  return p;
}

function label(text: string, cls = 'label astro-label') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

const texLoader = new THREE.TextureLoader();
function imageTexture(file: string) {
  const t = texLoader.load(`/assets/astro/${file}`);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Abstract base: a group with an opacity that fades as the layer is entered or left. */
abstract class Layer {
  group = new THREE.Group();
  opacity = 0;
  protected mats: THREE.ShaderMaterial[] = [];
  positions = new Map<string, THREE.Vector3>();
  setOpacity(o: number, projScale: number) {
    this.opacity = o;
    this.group.visible = o > 0.01;
    for (const m of this.mats) {
      if (m.uniforms.uOpacity) m.uniforms.uOpacity.value = o;
      if (m.uniforms.uProj) m.uniforms.uProj.value = projScale;
    }
    this.group.traverse((c) => { if (c instanceof CSS2DObject) c.visible = o > 0.5; });
  }
}

/**
 * The Milky Way, reconstructed from published structural parameters:
 * exponential disk (scale length 2.6 kpc, scale height 0.3 kpc), four logarithmic
 * spiral arms (pitch ≈ 12°), a central bar (half-length ≈ 5 kpc, 27° to the Sun–centre
 * line), dust lanes on the arms' inner edges and H II regions. Individual stars are
 * illustrative; the real nebulae are placed at their measured positions.
 * Units: 1 = 100 pc, Sun at the origin.
 */
export class MilkyWayModel extends Layer {
  readonly U = 100; // pc per unit
  centre = new THREE.Vector3(SUN_R_KPC * 10, 0, 0);
  constructor(catalog: CatalogEntry[]) {
    super();
    const N = QUALITY.low ? 45000 : 150000;
    const pos: number[] = [], col: number[] = [], size: number[] = [];
    const dust: number[] = [], dustC: number[] = [], dustS: number[] = [];
    const Rd = 26, pitch = 12 * D2R, armOff = 0.35;
    const armAngle = (r: number, k: number) => Math.log(Math.max(r, 20) / 20) / Math.tan(pitch) + (k * Math.PI) / 2 + armOff;
    const c = new THREE.Color();
    const toScene = (x: number, y: number, z: number) => [x + this.centre.x, y, z]; // galactocentric → Sun at origin
    for (let i = 0; i < N; i++) {
      let x: number, y: number, z: number;
      if (i < N * 0.16) { // bulge / bar
        const a = 27 * D2R;
        const bx = gauss() * 18, bz = gauss() * 7, by = gauss() * 5;
        x = bx * Math.cos(a) - bz * Math.sin(a); z = bx * Math.sin(a) + bz * Math.cos(a); y = by;
        c.setHSL(0.08, 0.6, 0.62 + Math.random() * 0.2);
        size.push(1.4);
      } else {
        const r = Math.min(160, -Rd * Math.log(Math.random() * Math.random() + 1e-6));
        const onArm = Math.random() < 0.62;
        const th = onArm ? armAngle(r, Math.floor(Math.random() * 4)) + gauss() * 0.22 : Math.random() * Math.PI * 2;
        x = -r * Math.cos(th); z = r * Math.sin(th); y = gauss() * 3 * (1 + r / 120);
        if (onArm && Math.random() < 0.55) c.setHSL(0.6, 0.5, 0.78 + Math.random() * 0.15); else c.setHSL(0.11, 0.35, 0.7 + Math.random() * 0.2);
        size.push(onArm ? 1.1 : 0.9);
        if (onArm && i % 4 === 0 && r > 20) { // dust on the arms' inner edge
          const thd = th - 0.12;
          dust.push(...toScene(-r * Math.cos(thd), gauss() * 1.2, r * Math.sin(thd)));
          dustC.push(0, 0, 0);
          dustS.push(5 + Math.random() * 6);
        }
        if (onArm && Math.random() < 0.006) { // H II regions
          pos.push(...toScene(x, y * 0.3, z));
          col.push(1.6, 0.45, 0.8);
          size.push(4);
        }
      }
      pos.push(...toScene(x, y, z));
      col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    const stars = pointsMaterial(false, 0.8, 12);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(dust, 3));
    dg.setAttribute('color', new THREE.Float32BufferAttribute(dustC, 3));
    dg.setAttribute('size', new THREE.Float32BufferAttribute(dustS, 1));
    const dm = pointsMaterial(true, 1, 40);
    this.mats.push(stars, dm);
    const sp = new THREE.Points(g, stars), dp = new THREE.Points(dg, dm);
    sp.frustumCulled = dp.frustumCulled = false;
    dp.renderOrder = 1;
    this.group.add(sp, dp);
    // Sun marker
    const sun = label('☉ Sun — you are here', 'label astro-label here');
    this.group.add(sun);
    this.positions.set('sun', new THREE.Vector3());
    const gc = label('Galactic Centre · Sagittarius A*');
    gc.position.copy(this.centre).add(new THREE.Vector3(0, 6, 0));
    this.group.add(gc);
    // real nebulae and clusters at measured positions
    for (const o of catalog.filter((o) => o.where === 'milky_way' && o.id !== 'sgr_a')) {
      const p = galacticXYZ(o.l, o.b, (o.d_pc ?? 0) / this.U);
      this.positions.set(o.id, p);
      const img = o.images[0];
      const imp = impostor(img ? imageTexture(img.file) : proceduralGalaxyTexture('elliptical', 3), Math.max(o.size_kpc * 10, 0.25));
      imp.position.copy(p);
      (imp.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1;
      this.mats.push(imp.material as THREE.ShaderMaterial);
      const lb = label(o.name.split(' (')[0]);
      lb.position.copy(p).add(new THREE.Vector3(0, 1.2, 0));
      this.group.add(imp, lb);
    }
    this.positions.set('sgr_a', this.centre.clone());
  }
}

/**
 * Tens of thousands of real galaxies: the 2MASS Redshift Survey (Huchra et al. 2012).
 * Positions are measured sky coordinates; distances come from redshift via Hubble's
 * law (H₀ = 70 km/s/Mpc), so nearby structure is smeared by peculiar velocities.
 * The empty band is the real "zone of avoidance" behind our galaxy's dust.
 * Units: 1 = 1 Mpc, the Milky Way at the origin.
 */
export class GalaxyField extends Layer {
  count = 0;
  ready: Promise<void>;
  constructor(catalog: CatalogEntry[]) {
    super();
    this.ready = fetch('/assets/astro/2mrs.bin').then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (!buf) return;
      const f = new Float32Array(buf);
      const n = f.length / 6;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
      const typeCol = [new THREE.Color('#ffd49a'), new THREE.Color('#ffe6c4'), new THREE.Color('#cfe0ff'), new THREE.Color('#a9c6ff')];
      for (let i = 0; i < n; i++) {
        pos.set([f[i * 6], f[i * 6 + 1], f[i * 6 + 2]], i * 3);
        const lum = Math.min(2.2, Math.pow(10, -0.4 * (f[i * 6 + 5] - 10.5)));
        const c = typeCol[f[i * 6 + 4] | 0].clone().multiplyScalar(0.55 + lum * 0.6);
        col.set([c.r, c.g, c.b], i * 3);
        size[i] = (f[i * 6 + 3] / 1000) * 2.5; // kpc → Mpc, with a halo
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('size', new THREE.BufferAttribute(size, 1));
      const m = pointsMaterial(false, 1.3, 48);
      this.mats.push(m);
      const p = new THREE.Points(g, m);
      p.frustumCulled = false;
      this.group.add(p);
      this.count = n;
    });
    // our galaxy at the origin
    const mw = impostor(proceduralGalaxyTexture('spiral', 7), 0.03);
    this.mats.push(mw.material as THREE.ShaderMaterial);
    const mwl = label('Milky Way — home');
    mwl.position.set(0, 0.04, 0);
    this.group.add(mw, mwl);
    this.positions.set('milky_way', new THREE.Vector3());
    // named galaxies: telescope-image impostors (procedural if no image)
    let k = 11;
    for (const o of catalog.filter((o) => o.where !== 'milky_way')) {
      const p = galacticXYZ(o.l, o.b, o.d_mpc ?? 0);
      this.positions.set(o.id, p);
      const img = o.images[0];
      const imp = impostor(img ? imageTexture(img.file) : proceduralGalaxyTexture(/ellip/i.test(o.kind) ? 'elliptical' : 'spiral', k++), (o.size_kpc / 1000) * 1.4);
      imp.position.copy(p);
      this.mats.push(imp.material as THREE.ShaderMaterial);
      const lb = label(o.name.split(' (')[0]);
      lb.position.copy(p).add(new THREE.Vector3(0, (o.size_kpc / 1000) * 0.9, 0));
      this.group.add(imp, lb);
    }
  }
}
