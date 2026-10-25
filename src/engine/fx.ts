/** Reusable visual effects: sky dome, starfields, weather, sparks, fireflies. */
import * as THREE from 'three';

export const NOISE_GLSL = /* glsl */ `
float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5; } return s; }
`;

export interface SkyUniforms {
  top: THREE.Color; horizon: THREE.Color; bottom: THREE.Color; sunDir: THREE.Vector3; sunColor: THREE.Color; stars: number; nebula: number; time: number; tint: THREE.Color; tintAmt: number;
  nebulaA: THREE.Color; nebulaB: THREE.Color; aurora: number; lightning: number;
}

export function makeSkyDome(radius = 900) {
  const uniforms = {
    uTop: { value: new THREE.Color('#05030f') }, uHorizon: { value: new THREE.Color('#1a1033') }, uBottom: { value: new THREE.Color('#020106') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.1, -1).normalize() }, uSunColor: { value: new THREE.Color('#ff9a5a') }, uSun: { value: 0 },
    uStars: { value: 1 }, uNebula: { value: 0.6 }, uTime: { value: 0 }, uTint: { value: new THREE.Color('#000000') }, uTintAmt: { value: 0 },
    uNebA: { value: new THREE.Color('#5b2bd6') }, uNebB: { value: new THREE.Color('#0fb5c9') }, uAurora: { value: 0 }, uLightning: { value: 0 },
    uClouds: { value: 0 }, uCloudDark: { value: new THREE.Color('#1a1420') }, uBand: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop,uHorizon,uBottom,uSunDir,uSunColor,uTint,uNebA,uNebB,uCloudDark; uniform float uSun,uStars,uNebula,uTime,uTintAmt,uAurora,uLightning,uClouds,uBand;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(h, 0.55)) : mix(uHorizon, uBottom, pow(-h, 0.4));
        // nebula
        float n = fbm(d*3.0 + vec3(0.0, uTime*0.005, 0.0));
        float n2 = fbm(d*6.0 - vec3(uTime*0.004));
        col += uNebula * (uNebA * pow(n, 3.0) * 1.6 + uNebB * pow(n2, 4.0) * 1.3) * smoothstep(-0.2, 0.4, h + 0.3);
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        // Milky Way band: a great circle of unresolved stars with dark dust lanes
        if (uBand > 0.0) {
          vec3 bn = normalize(vec3(0.35, 0.8, 0.48));
          float bd = abs(dot(d, bn));
          float band = exp(-bd*bd*28.0);
          float dust = fbm(d*9.0 + 4.0);
          float grain = fbm(d*40.0);
          col += uBand * band * (vec3(0.55,0.5,0.6)*(0.4+grain*0.9)) * smoothstep(0.25, 0.75, dust + 0.2) ;
          col += uBand * exp(-bd*bd*120.0) * vec3(0.9,0.75,0.6) * 0.25 * (1.0 - smoothstep(0.45,0.7,dust));
        }
        // stars
        vec3 sp = floor(d*420.0);
        float st = hash(sp);
        float tw = 0.6 + 0.4*sin(uTime*2.0 + st*80.0);
        col += uStars * smoothstep(0.9975, 1.0, st) * tw * smoothstep(-0.1, 0.25, h) * vec3(0.9,0.95,1.0) * 1.6;
        // sun glow
        col += uSun * uSunColor * (pow(sd, 600.0)*6.0 + pow(sd, 12.0)*0.5 + pow(sd,3.0)*0.15);
        // clouds: a high layer projected onto a dome, lit from the sun side, rimmed near the sun
        if (uClouds > 0.0 && h > 0.0) {
          vec2 cp = d.xz / (d.y + 0.12) * 1.4;
          float cn = fbm(vec3(cp*1.2 + vec2(uTime*0.006, uTime*0.002), uTime*0.003));
          float cov = smoothstep(0.45, 0.78, cn) * smoothstep(0.0, 0.18, h);
          float lit = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 3.0);
          vec3 cc = mix(uCloudDark, uSunColor*1.2, lit*0.75 + pow(sd, 8.0)*1.5);
          col = mix(col, cc * (0.55 + 0.45*fbm(vec3(cp*3.0, 1.0))), cov * uClouds);
        }
        // aurora ribbons
        if (uAurora > 0.0 && h > 0.05) {
          float a = fbm(vec3(d.x*3.0, d.z*3.0 + uTime*0.05, uTime*0.03));
          float band = smoothstep(0.35, 0.0, abs(d.z*0.8 + sin(d.x*4.0 + uTime*0.2)*0.25 - 0.1 + (a-0.5)*0.4));
          col += uAurora * band * mix(vec3(0.1,1.0,0.6), vec3(0.6,0.2,1.0), smoothstep(0.1,0.7,h)) * smoothstep(0.05, 0.4, h) * 0.9;
        }
        col = mix(col, uTint * (0.35 + 0.65*smoothstep(-0.2, 0.8, h)), uTintAmt);
        col += uLightning * vec3(0.7,0.75,1.0) * smoothstep(-0.1, 0.6, h);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

export function makeStarfield(count = 6000, radius = 600, size = 1.6) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
    const r = radius * (0.7 + Math.random() * 0.3);
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    const temp = Math.random();
    c.setHSL(temp < 0.2 ? 0.08 : temp < 0.5 ? 0.6 : 0.62, temp < 0.5 ? 0.6 : 0.2, 0.75 + Math.random() * 0.25);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, fog: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

/** Rain / snow / storm particles in a box that follows the camera. Fall speed scales with gravity. */
export class Weather {
  points: THREE.Points;
  private pos: Float32Array;
  private N = 5000;
  kind: 'clear' | 'rain' | 'snow' | 'storm' | 'aurora' = 'clear';
  lightning = 0;
  private nextBolt = 3;
  onThunder?: () => void;
  constructor(private box = 60) {
    this.pos = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; i++) this.pos.set([(Math.random() - 0.5) * box, Math.random() * 40, (Math.random() - 0.5) * box], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: '#a8c8ff', size: 0.12, transparent: true, opacity: 0.6, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.visible = false;
  }
  set(kind: Weather['kind']) {
    this.kind = kind;
    const m = this.points.material as THREE.PointsMaterial;
    this.points.visible = kind === 'rain' || kind === 'snow' || kind === 'storm';
    m.color.set(kind === 'snow' ? '#ffffff' : '#9fb8ff');
    m.size = kind === 'snow' ? 0.22 : 0.1;
    m.opacity = kind === 'snow' ? 0.9 : 0.55;
  }
  update(dt: number, cam: THREE.Vector3, gravity: number, t: number) {
    this.lightning = Math.max(0, this.lightning - dt * 3);
    if (!this.points.visible) return;
    const speed = (this.kind === 'snow' ? 2.2 : this.kind === 'storm' ? 30 : 22) * Math.max(0.05, gravity);
    const drift = this.kind === 'storm' ? 6 : this.kind === 'snow' ? 0.8 : 1;
    const h = this.box / 2;
    for (let i = 0; i < this.N; i++) {
      let y = this.pos[i * 3 + 1] - speed * dt;
      let x = this.pos[i * 3] + Math.sin(t + i) * drift * dt;
      let z = this.pos[i * 3 + 2];
      if (y < cam.y - 10) y += 40;
      if (x - cam.x > h) x -= this.box; else if (x - cam.x < -h) x += this.box;
      if (z - cam.z > h) z -= this.box; else if (z - cam.z < -h) z += this.box;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    if (this.kind === 'storm') {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.lightning = 1;
        this.nextBolt = 2.5 + Math.random() * 5;
        setTimeout(() => this.onThunder?.(), 300 + Math.random() * 900);
      }
    }
  }
}

/** Short-lived burst of glowing sparks (spawning, portals, impacts). */
export class Sparks {
  points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private col: Float32Array;
  private N = 1500;
  private cursor = 0;
  constructor() {
    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    this.life = new Float32Array(this.N);
    this.col = new Float32Array(this.N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.18, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
  }
  burst(at: THREE.Vector3, color: string | THREE.Color, n = 160, speed = 6) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.N;
      const u = Math.random() * 2 - 1, th = Math.random() * 6.283, s = Math.sqrt(1 - u * u);
      const v = speed * (0.3 + Math.random() * 0.7);
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([v * s * Math.cos(th), v * u + 1.5, v * s * Math.sin(th)], i * 3);
      this.life[i] = 0.8 + Math.random() * 0.8;
      this.col.set([c.r, c.g, c.b], i * 3);
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const f = Math.max(0, this.life[i]);
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
        this.vel[i * 3 + k] *= Math.pow(0.2, dt);
      }
      this.vel[i * 3 + 1] -= 2 * dt;
      if (f <= 0) { this.pos[i * 3 + 1] = -9999; }
      this.col[i * 3] *= 0.985; this.col[i * 3 + 1] *= 0.985; this.col[i * 3 + 2] *= 0.985;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

/** Drifting glowing motes (fireflies, embers, dust). */
export function makeMotes(count: number, area: THREE.Vector3, color: string, size = 0.12) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.set([(Math.random() - 0.5) * area.x, Math.random() * area.y, (Math.random() - 0.5) * area.z], i * 3);
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSize: { value: size * 300 }, uRise: { value: 0.3 }, uH: { value: area.y } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `attribute float seed; uniform float uTime,uSize,uRise,uH; varying float vA;
      void main(){ vec3 p = position; float t = uTime + seed;
        p.x += sin(t*0.7)*0.8; p.z += cos(t*0.53)*0.8; p.y = mod(p.y + uTime*uRise + sin(t)*0.3, uH);
        vA = 0.5 + 0.5*sin(t*3.0);
        vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uSize / -mv.z; }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d); gl_FragColor = vec4(uColor*a*vA*1.6, a*vA); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}
