/**
 * Shared environment dressing: volumetric-looking fog, light shafts, HDRI backdrops,
 * and realm-specific atmosphere layers. Scene content only — no renderer/post stack.
 */
import * as THREE from 'three';
import { assets } from './assets';
import { makeMotes } from './fx';

export type HdriPack = { texture: THREE.DataTexture; sunDir: THREE.Vector3; horizon: THREE.Color; zenith: THREE.Color };

/** Load several HDRIs by id; missing files are omitted (engine keeps procedural fallbacks). */
export async function loadHdris(ids: string[]): Promise<Map<string, HdriPack>> {
  await assets.init();
  const map = new Map<string, HdriPack>();
  await Promise.all(
    ids.map(async (id) => {
      const h = await assets.hdri(id);
      if (h) map.set(id, h);
    }),
  );
  return map;
}

export interface HdriBackdropOpts {
  /** When true, hide the procedural sky dome mesh and use the HDRI as scene.background. */
  useBackground?: boolean;
  /** PMREM environment intensity (reflections). */
  envIntensity?: number;
  /** Background display intensity (three r163+). */
  bgIntensity?: number;
}

/** Point a directional light and optional sunWorld vector along an HDRI's brightest region. */
export function aimKeyLightFromHdri(sun: THREE.DirectionalLight, pack: HdriPack, distance = 120) {
  const d = pack.sunDir.clone();
  if (d.y < 0.06) d.y = 0.06;
  d.normalize();
  sun.position.copy(d.clone().multiplyScalar(distance));
  sun.target.position.set(0, 0, 0);
  return d;
}

/** God-ray-like columns: additive cones aimed at the sun, animated with slow noise. */
export function makeLightShafts(count: number, origin: THREE.Vector3, color: string, height = 55, spread = 38) {
  const g = new THREE.Group();
  g.position.copy(origin);
  const col = new THREE.Color(color);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: col },
      uOpacity: { value: 0.22 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vH;
      varying float vA;
      void main(){
        vH = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = 0.5 + 0.5 * sin(uTime * 0.4 + position.x * 0.08 + position.z * 0.06);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vH;
      varying float vA;
      void main(){
        float along = smoothstep(0.0, 1.0, vH);
        float rim = pow(along, 2.2) * (1.0 - along * 0.25);
        float a = rim * vA * uOpacity;
        gl_FragColor = vec4(uColor * rim * 1.4, a);
      }`,
  });
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 4 + rnd() * spread;
    const h = height * (0.55 + rnd() * 0.55);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.8 + rnd() * 2.5, h, 8, 1, true), mat);
    cone.position.set(Math.cos(a) * r, h * 0.45, Math.sin(a) * r);
    cone.rotation.x = Math.PI;
    cone.rotation.z = rnd() * 0.2 - 0.1;
    g.add(cone);
  }
  g.userData.tick = (t: number) => {
    (mat.uniforms.uTime.value as number) = t;
  };
  g.userData.setStrength = (s: number) => {
    (mat.uniforms.uOpacity.value as number) = s;
  };
  return g;
}

/** Low-lying mist disk (shader) — reads as ground fog / valley haze in VR. */
export function makeGroundMist(radius: number, color: string, y = 0.04, strength = 0.35) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
      }
      void main(){
        vec2 p = vUv * 8.0 + vec2(uTime * 0.012, uTime * 0.008);
        float n = noise(p) * 0.6 + noise(p * 2.3 + 4.0) * 0.4;
        float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.65, vUv.y);
        float a = edge * n * uStrength * smoothstep(1.0, 0.15, length(vUv - 0.5) * 2.0);
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const disk = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), mat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = y;
  disk.renderOrder = 1;
  disk.userData.tick = (t: number) => {
    (mat.uniforms.uTime.value as number) = t;
  };
  disk.userData.setStrength = (s: number) => {
    (mat.uniforms.uStrength.value as number) = s;
  };
  return disk;
}

/** Thin additive shell for horizon atmospheric tint (Earth-like or stylised). */
export function makeAtmosphereShell(radius: number, inner: string, outer: string) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uInner: { value: new THREE.Color(inner) },
      uOuter: { value: new THREE.Color(outer) },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uInner, uOuter; varying vec3 vD;
      void main(){
        float h = vD.y * 0.5 + 0.5;
        float a = pow(1.0 - abs(vD.y), 3.0) * 0.35;
        vec3 col = mix(uInner, uOuter, pow(h, 0.6));
        gl_FragColor = vec4(col, a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  return mesh;
}

/** Macro lab floor grid for the hydrogen realm (cinematic product-shot scale). */
export function makeStudioGrid(size: number, color = '#1a4a7a', y = -7) {
  const g = new THREE.GridHelper(size, size, new THREE.Color(color), new THREE.Color('#0c2238'));
  (g.material as THREE.Material).transparent = true;
  (g.material as THREE.Material).opacity = 0.42;
  g.position.y = y;
  return g;
}

/** Reflective dark floor under the orbital (studio cyclorama base). */
export function makeStudioFloor(radius = 14, y = -7) {
  const m = new THREE.MeshStandardMaterial({
    color: '#0a1420',
    metalness: 0.65,
    roughness: 0.22,
    envMapIntensity: 1.8,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), m);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = y;
  floor.receiveShadow = true;
  return floor;
}

/** Drifting interstellar dust / nebula grains (additive points). */
export function makeCosmicDust(count: number, radius: number) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = radius * Math.cbrt(Math.random());
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * u * 0.35, r * s * Math.sin(th)], i * 3);
    const t = Math.random();
    c.setHSL(0.55 + t * 0.15, 0.5 + t * 0.3, 0.35 + Math.random() * 0.35);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 2.8,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pts.frustumCulled = false;
  pts.userData.spin = (t: number) => {
    pts.rotation.y = t * 0.008;
  };
  return pts;
}

/** Futuristic floating panels / antenna fins for the Nexus (pure geometry, no assets). */
export function makeNexusSetDressing() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#3a3648', metalness: 0.9, roughness: 0.28, envMapIntensity: 2 });
  const glow = new THREE.MeshBasicMaterial({ color: '#5ad8ff' });
  let seed = 19;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rnd() * 0.2;
    const r = 22 + rnd() * 14;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.5 + rnd() * 4, 1.2 + rnd() * 2.8), metal);
    panel.position.set(Math.cos(a) * r, 4 + rnd() * 12, Math.sin(a) * r);
    panel.rotation.set(rnd() * 0.4, a + Math.PI / 2, rnd() * 0.5);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.02, panel.geometry.parameters.height as number, 0.04), glow);
    band.position.y = 0;
    panel.add(band);
    g.add(panel);
  }
  // data pylons near the platform rim
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 5, 6), metal);
    pylon.position.set(Math.cos(a) * 19.5, 2.5, Math.sin(a) * 19.5);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 32), glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.2;
    pylon.add(ring);
    g.add(pylon);
  }
  return g;
}

/** Wafting pollen / ash for village mornings. */
export function makePollen(count: number, area: THREE.Vector3, color: string) {
  return makeMotes(count, area, color, 0.04);
}