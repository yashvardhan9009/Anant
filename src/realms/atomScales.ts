/**
 * "Powers of ten" layers around the hydrogen atom, all in Bohr radii (a₀ = 0.529 Å):
 *
 *   liquid water (~nm)  →  one H₂O molecule (~Å)  →  H atom orbital  →  proton (~fm)
 *
 * The H atom at the origin of the atom realm is one of the hydrogens of the central
 * water molecule, so zooming is continuous.
 */
import * as THREE from 'three';
import { QUALITY } from '../engine/quality';

export const A0_M = 5.29177e-11;
export const PROTON_RADIUS_A0 = 0.8414e-15 / A0_M; // CODATA charge radius

// Water geometry (gas-phase, measured): r(O–H) = 0.9584 Å, ∠HOH = 104.45°
const R_OH = 0.9584e-10 / A0_M;
const ANG = (104.45 * Math.PI) / 180;
export const WATER = {
  H1: new THREE.Vector3(0, 0, 0),
  O: new THREE.Vector3(-R_OH, 0, 0),
  H2: new THREE.Vector3(-R_OH + R_OH * Math.cos(Math.PI - ANG), R_OH * Math.sin(Math.PI - ANG), 0),
};
const CENTRE = WATER.O.clone().add(WATER.H1).add(WATER.H2).multiplyScalar(1 / 3);

/**
 * Promolecule electron density: the sum of isolated-atom densities, with oxygen
 * described by Slater-type orbitals (Slater's rules: ζ1s = 7.70, ζ2s,2p = 2.275)
 * and hydrogen by its exact 1s density e^{-2r}/π. A good picture of where the
 * electrons are; it omits the (small) bonding rearrangement.
 */
const MOL_GLSL = /* glsl */ `
  uniform vec3 uO, uH1, uH2;
  uniform float uInvS, uRadius, uSteps, uGain, uOpacity, uTime;
  uniform vec3 uCenter;
  varying vec3 vWorld;
  const float PI = 3.14159265;
  float rhoH(float r) { return exp(-2.0 * r) / PI; }
  float rhoO(float r) {
    float z1 = 7.70, z2 = 2.275;
    float core = 2.0 * z1 * z1 * z1 / PI * exp(-2.0 * z1 * r);
    float val = 6.0 * pow(2.0 * z2, 5.0) / (24.0 * 4.0 * PI) * r * r * exp(-2.0 * z2 * r);
    return core + val;
  }
  float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
    vec3 oc = ro - uCenter;
    float b = dot(oc, rd), c = dot(oc, oc) - uRadius * uRadius, h = b * b - c;
    if (h < 0.0) discard;
    h = sqrt(h);
    float t0 = max(-b - h, 0.0), t1 = -b + h;
    if (t1 <= 0.0) discard;
    float dt = (t1 - t0) / uSteps;
    float jit = h12(gl_FragCoord.xy + fract(uTime * 3.0) * 17.0);
    vec3 col = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < 128; i++) {
      if (float(i) >= uSteps) break;
      vec3 p = (ro + rd * (t0 + (float(i) + jit) * dt)) * uInvS;   // → Bohr radii
      float dO = rhoO(length(p - uO)), d1 = rhoH(length(p - uH1)), d2 = rhoH(length(p - uH2));
      float d = dO + d1 + d2;
      float e = min(pow(d / 0.3, 0.42), 3.0) * dt * uInvS * uGain;
      // oxygen's density glows cool white-blue, hydrogens' warm amber (same palette as the orbital)
      vec3 cc = (dO * vec3(0.55, 0.78, 1.0) + (d1 + d2) * vec3(1.0, 0.62, 0.25)) / max(d, 1e-6);
      col += T * cc * e;
      T *= exp(-e * 0.5);
      if (T < 0.02) break;
    }
    gl_FragColor = vec4(col * uOpacity, (1.0 - T) * uOpacity);
  }
`;

export class WaterMolecule {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uO: { value: WATER.O }, uH1: { value: WATER.H1 }, uH2: { value: WATER.H2 }, uCenter: { value: new THREE.Vector3() },
        uInvS: { value: 1 }, uRadius: { value: 1 }, uSteps: { value: QUALITY.low ? 32 : 96 }, uGain: { value: 0.35 }, uOpacity: { value: 0 }, uTime: { value: 0 },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: MOL_GLSL,
      side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
  /** S = scene units per Bohr radius */
  layout(S: number, opacity: number, t: number) {
    const R = 7 * S;
    const c = CENTRE.clone().multiplyScalar(S);
    this.mesh.position.copy(c);
    this.mesh.scale.setScalar(Math.min(R, 1500));
    const u = this.mat.uniforms;
    u.uCenter.value.copy(c);
    u.uRadius.value = R;
    u.uInvS.value = 1 / S;
    u.uOpacity.value = opacity;
    u.uTime.value = t;
    this.mesh.visible = opacity > 0.01;
  }
}

/**
 * Liquid water: molecules at the real number density of water (33.4 nm⁻³) with
 * real geometry. Positions and the jiggle are ILLUSTRATIVE (no molecular dynamics).
 */
export class LiquidWater {
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  private base: Float32Array;
  constructor() {
    const N = QUALITY.low ? 180 : 520;
    const nm3 = N / 33.4;
    const Ra0 = Math.cbrt((3 * nm3) / (4 * Math.PI)) * 1e-9 / A0_M; // sphere holding N molecules
    const mols: { o: THREE.Vector3; q: THREE.Quaternion }[] = [{ o: WATER.O.clone(), q: new THREE.Quaternion() }];
    const minOO = 2.75e-10 / A0_M; // typical O–O distance in liquid water
    let tries = 0;
    while (mols.length < N && tries++ < N * 400) {
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (v.lengthSq() > 1) continue;
      const o = v.multiplyScalar(Ra0).add(WATER.O);
      if (mols.some((m) => m.o.distanceToSquared(o) < minOO * minOO * 0.85)) continue;
      mols.push({ o, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28)) });
    }
    const pos: number[] = [], size: number[] = [], col: number[] = [], seed: number[] = [];
    const hA = WATER.H1.clone().sub(WATER.O), hB = WATER.H2.clone().sub(WATER.O);
    for (const [i, m] of mols.entries()) {
      const atoms: [THREE.Vector3, number, [number, number, number]][] = [
        [m.o, 2.9, [0.55, 0.78, 1.0]],
        [m.o.clone().add(hA.clone().applyQuaternion(m.q)), 2.0, [1.0, 0.62, 0.25]],
        [m.o.clone().add(hB.clone().applyQuaternion(m.q)), 2.0, [1.0, 0.62, 0.25]],
      ];
      for (const [p, s, c] of atoms) {
        pos.push(p.x, p.y, p.z);
        size.push(s);
        col.push(...c);
        seed.push(i === 0 ? -1 : Math.random() * 100); // the central molecule does not jiggle
      }
    }
    this.base = new Float32Array(pos);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uS: { value: 1 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uProj: { value: 800 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float size; attribute vec3 color; attribute float seed; uniform float uS, uTime, uProj; varying vec3 vC; varying float vCore;
        void main(){
          vec3 p = position;
          if (seed >= 0.0) p += vec3(sin(uTime*1.7 + seed), sin(uTime*1.3 + seed*1.7), sin(uTime*1.1 + seed*2.3)) * 0.35; // illustrative thermal motion
          vec4 mv = modelViewMatrix * vec4(p * uS, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(size * uS * uProj / -mv.z, 1.0, 256.0);
          vC = color; vCore = seed < 0.0 ? 1.0 : 0.0;
        }`,
      fragmentShader: `uniform float uOpacity; varying vec3 vC; varying float vCore;
        void main(){ vec2 q = gl_PointCoord - 0.5; float r2 = dot(q,q); float a = exp(-r2*16.0) + exp(-r2*60.0)*0.8;
          gl_FragColor = vec4(vC * a * uOpacity * (0.6 + vCore*0.6), a * uOpacity); }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }
  layout(S: number, opacity: number, t: number, projScale: number) {
    const u = this.mat.uniforms;
    u.uS.value = S;
    u.uOpacity.value = opacity;
    u.uTime.value = t;
    u.uProj.value = projScale;
    this.points.visible = opacity > 0.01;
  }
}

/**
 * The proton at its TRUE size (r ≈ 0.84 fm). What is inside is a cartoon of QCD:
 * three valence quarks (u, u, d) tied by gluon flux, in a fizz of virtual
 * quark–antiquark pairs. Quarks have no definite positions — this is ARTISTIC.
 */
export class ProtonCore {
  group = new THREE.Group();
  private quarks: THREE.Mesh[] = [];
  private flux: THREE.Mesh[] = [];
  private sea: THREE.Points;
  private shell: THREE.Mesh;
  constructor() {
    const colours = ['#ff3b3b', '#3bff6e', '#3b8bff']; // colour charge: red, green, blue
    for (const c of colours) {
      const q = new THREE.Mesh(new THREE.SphereGeometry(0.09, 32, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2.2) }));
      this.quarks.push(q);
      this.group.add(q);
    }
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: '#ffe2a8', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.flux.push(f);
      this.group.add(f);
    }
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(vec3(1.0, 0.55, 0.3) * f * 0.9, f * 0.6); }`,
      }),
    );
    this.group.add(this.shell);
    const N = 400;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.sea = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffd0a0', size: 0.03, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(this.sea);
    this.group.visible = false;
  }
  /** R = proton radius in scene units */
  layout(R: number, opacity: number, t: number) {
    this.group.visible = opacity > 0.01;
    if (!this.group.visible) return;
    this.group.scale.setScalar(R);
    const pts = [0, 1, 2].map((i) => new THREE.Vector3(
      Math.sin(t * (1.3 + i * 0.37) + i * 2.1) * 0.45, Math.sin(t * (1.1 + i * 0.29) + i * 4.2) * 0.45, Math.cos(t * (0.9 + i * 0.41) + i) * 0.45));
    pts.forEach((p, i) => this.quarks[i].position.copy(p));
    for (let i = 0; i < 3; i++) {
      const a = pts[i], b = pts[(i + 1) % 3];
      const f = this.flux[i];
      f.position.copy(a).add(b).multiplyScalar(0.5);
      f.scale.set(1, a.distanceTo(b), 1);
      f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      (f.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(t * 9 + i);
    }
    const arr = this.sea.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < arr.length / 3; i++) {
      if (Math.random() < 0.08) {
        const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        if (v.lengthSq() < 1) arr.set([v.x * 0.9, v.y * 0.9, v.z * 0.9], i * 3);
      }
    }
    this.sea.geometry.attributes.position.needsUpdate = true;
    for (const q of this.quarks) ((q.material as THREE.MeshBasicMaterial).opacity = opacity);
  }
}

/** A round scale-bar length (1, 2 or 5 × 10ⁿ m) and its label. */
export function niceLength(meters: number): { m: number; label: string } {
  const p = Math.floor(Math.log10(meters));
  const base = meters / 10 ** p;
  const n = base >= 5 ? 5 : base >= 2 ? 2 : 1;
  const m = n * 10 ** p;
  const units: [number, string][] = [[1e-15, 'fm'], [1e-12, 'pm'], [1e-10, 'Å'], [1e-9, 'nm'], [1e-6, 'µm']];
  let u = units[0];
  for (const x of units) if (m >= x[0]) u = x;
  const v = m / u[0];
  return { m, label: `${v >= 100 ? v.toFixed(0) : +v.toPrecision(2)} ${u[1]}` };
}
