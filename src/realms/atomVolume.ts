/**
 * Volumetric hydrogen orbital: every pixel integrates the exact |ψ|² along its
 * view ray (emission/absorption ray-marching). The wavefunction R_nl·Y_lm is
 * evaluated in the shader with the same Laguerre/Legendre recurrences as
 * shared/hydrogen.ts, so what glows is the true probability density.
 *
 * During a transition the state is a superposition a·ψ₁ + b·e^{-iΔEt/ħ}·ψ₂ and
 * the density |…|² = a²ψ₁² + b²ψ₂² + 2ab·ψ₁ψ₂·cos(ΔE·t/ħ) oscillates — that
 * oscillating charge is what radiates the photon. Shown slowed by ~10¹⁵.
 */
import * as THREE from 'three';
import { psi, expectedRadius } from '../../shared/hydrogen';
import { QUALITY } from '../engine/quality';

const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
export const radialNorm = (n: number, l: number) => Math.sqrt(Math.pow(2 / n, 3) * (fact(n - l - 1) / (2 * n * fact(n + l))));
export const angularNorm = (l: number, m: number) => {
  const am = Math.abs(m);
  const N = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (fact(l - am) / fact(l + am)));
  return m === 0 ? N : Math.SQRT2 * N;
};
/** Bounding radius (Bohr radii) that contains essentially all of the density. */
export const boundRadius = (n: number, l: number) => 2.3 * expectedRadius(n, l) + 4;

const maxCache = new Map<string, number>();
/** Peak of |ψ|² over space (grid search), used to normalise brightness per orbital. */
export function maxDensity(n: number, l: number, m: number) {
  const k = `${n}${l}${m}`;
  if (maxCache.has(k)) return maxCache.get(k)!;
  const R = boundRadius(n, l), G = 44;
  let best = 1e-12;
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let q = 0; q < G; q++) {
    const x = ((i + 0.5) / G * 2 - 1) * R, y = ((j + 0.5) / G * 2 - 1) * R, z = ((q + 0.5) / G * 2 - 1) * R;
    const v = psi(n, l, m, x, y, z) ** 2;
    if (v > best) best = v;
  }
  maxCache.set(k, best);
  return best;
}

const GLSL = /* glsl */ `
  uniform int uN, uL, uM, uN2, uL2, uM2;
  uniform float uRN, uYN, uRN2, uYN2, uKA, uKB;
  uniform float uMix, uSuper, uA, uB, uPhase;
  uniform float uInvFit, uRadius, uSlice, uTime, uGain, uSteps, uOpacity;
  uniform vec3 uPos, uNeg;
  varying vec3 vWorld;

  float laguerre(int k, float a, float x) {
    if (k == 0) return 1.0;
    float L0 = 1.0, L1 = 1.0 + a - x;
    for (int i = 1; i < 4; i++) {
      if (i >= k) break;
      float fi = float(i);
      float L2 = ((2.0 * fi + 1.0 + a - x) * L1 - (fi + a) * L0) / (fi + 1.0);
      L0 = L1; L1 = L2;
    }
    return L1;
  }
  float legendre(int l, int m, float x) {
    float pmm = 1.0;
    if (m > 0) {
      float s = sqrt(max(0.0, 1.0 - x * x)), f = 1.0;
      for (int i = 1; i <= 3; i++) { if (i > m) break; pmm *= f * s; f += 2.0; }
    }
    if (l == m) return pmm;
    float pmmp1 = x * (2.0 * float(m) + 1.0) * pmm;
    if (l == m + 1) return pmmp1;
    float pll = 0.0;
    for (int ll = 2; ll <= 3; ll++) {
      int L = m + ll;
      if (L > l) break;
      pll = ((2.0 * float(L) - 1.0) * x * pmmp1 - (float(L) + float(m) - 1.0) * pmm) / float(L - m);
      pmm = pmmp1; pmmp1 = pll;
    }
    return pll;
  }
  // p in Bohr radii, scene axes (physics z = scene y, physics y = scene z)
  float psiAt(int n, int l, int m, float RN, float YN, vec3 p) {
    float r = length(p);
    float rho = 2.0 * r / float(n);
    float R = RN * exp(-0.5 * rho) * (l == 0 ? 1.0 : pow(rho, float(l))) * laguerre(n - l - 1, 2.0 * float(l) + 1.0, rho);
    float ct = r > 1e-6 ? p.y / r : 1.0;
    float ph = atan(p.z, p.x);
    int am = m < 0 ? -m : m;
    float ang = m > 0 ? cos(float(am) * ph) : (m < 0 ? sin(float(am) * ph) : 1.0);
    return R * YN * legendre(l, am, ct) * ang;
  }
  float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
    float b = dot(ro, rd), c = dot(ro, ro) - uRadius * uRadius, h = b * b - c;
    if (h < 0.0) discard;
    h = sqrt(h);
    float t0 = max(-b - h, 0.0), t1 = -b + h;
    if (t1 <= 0.0) discard;
    float dt = (t1 - t0) / uSteps;
    float jit = h12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
    vec3 col = vec3(0.0);
    float T = 1.0;
    bool needB = uSuper > 0.5 || uMix > 0.001;
    for (int i = 0; i < 160; i++) {
      if (float(i) >= uSteps) break;
      vec3 p = ro + rd * (t0 + (float(i) + jit) * dt);
      if (uSlice > 0.5 && p.z > 0.0) continue;
      vec3 q = p * uInvFit;
      float a = uMix < 0.999 || uSuper > 0.5 ? psiAt(uN, uL, uM, uRN, uYN, q) : 0.0;
      float bb = needB ? psiAt(uN2, uL2, uM2, uRN2, uYN2, q) : 0.0;
      float d, s;
      if (uSuper > 0.5) {
        // true (normalised) wavefunctions keep the interference pattern physically correct;
        // only the overall brightness is normalised
        d = (uA * uA * a * a + uB * uB * bb * bb + 2.0 * uA * uB * a * bb * cos(uPhase)) * (uA * uA * uKA + uB * uB * uKB);
        s = uA * a + uB * bb * cos(uPhase);
      } else {
        d = mix(a * a * uKA, bb * bb * uKB, uMix);
        s = mix(a, bb, uMix);
      }
      // emission per Bohr radius of path, so brightness is independent of zoom
      float e = pow(max(d, 0.0), 0.85) * dt * uInvFit * uGain;
      vec3 cc = s >= 0.0 ? uPos : uNeg;
      // hot cores glow white, wisps keep their colour
      cc = mix(cc, vec3(1.0, 0.96, 0.9), smoothstep(0.6, 1.0, d) * 0.5);
      col += T * cc * e;
      T *= exp(-e * 0.55);
      if (T < 0.015) break;
    }
    gl_FragColor = vec4(col * uOpacity, (1.0 - T) * uOpacity);
  }
`;

export class OrbitalVolume {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uN: { value: 1 }, uL: { value: 0 }, uM: { value: 0 }, uN2: { value: 1 }, uL2: { value: 0 }, uM2: { value: 0 },
        uRN: { value: 1 }, uYN: { value: 1 }, uRN2: { value: 1 }, uYN2: { value: 1 }, uKA: { value: 1 }, uKB: { value: 1 },
        uMix: { value: 0 }, uSuper: { value: 0 }, uA: { value: 1 }, uB: { value: 0 }, uPhase: { value: 0 },
        uInvFit: { value: 1 }, uRadius: { value: 8 }, uSlice: { value: 0 }, uTime: { value: 0 }, uGain: { value: 0.11 },
        uSteps: { value: QUALITY.low ? 28 : 120 }, uOpacity: { value: 1 },
        uPos: { value: new THREE.Color('#ff9a3c') }, uNeg: { value: new THREE.Color('#3fa9ff') },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: GLSL,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** state A (current) and B (target) */
  setStates(a: [number, number, number], b: [number, number, number]) {
    const u = this.mat.uniforms;
    [u.uN.value, u.uL.value, u.uM.value] = a;
    [u.uN2.value, u.uL2.value, u.uM2.value] = b;
    u.uRN.value = radialNorm(a[0], a[1]); u.uYN.value = angularNorm(a[1], a[2]);
    u.uRN2.value = radialNorm(b[0], b[1]); u.uYN2.value = angularNorm(b[1], b[2]);
    u.uKA.value = 1 / maxDensity(...a);
    u.uKB.value = 1 / maxDensity(...b);
  }

  /** fit: scene units per Bohr radius (including user scale) */
  layout(fit: number, a: [number, number, number], b: [number, number, number]) {
    const R = Math.max(boundRadius(a[0], a[1]), boundRadius(b[0], b[1])) * fit;
    this.mesh.scale.setScalar(Math.min(R, 1500)); // proxy geometry only needs to cover the screen
    this.mat.uniforms.uRadius.value = R;
    this.mat.uniforms.uInvFit.value = 1 / fit;
  }
}
