import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Realm, InfoCard, FrameCtx } from '../engine/Realm';
import { makeSkyDome, makeStarfield, NOISE_GLSL } from '../engine/fx';
import { radialTexture } from './Atom';
import { QUALITY } from '../engine/quality';
import { assets } from '../engine/assets';
import { cosmosDisplayHeight, cosmicLayer, formatLength } from '../../shared/scale';
import { MilkyWayModel, GalaxyField, CatalogEntry } from './cosmicLayers';
import { resolveAstro, formatDistance } from '../../shared/astro';
import { escapeHtml } from './Village';
import type { CameraRig } from '../engine/CameraRig';
import type { WorldState, Env } from '../../shared/worldState';
import type { RealmId } from '../../shared/commands';
import { NBody, BodyDef, displayRadius, compress, decompress } from '../../shared/physics';

const TRAIL = 700;

/** Equirect lookup + asinh stretch of the (nearly linear) Milky Way panorama. */
const SKY_STRETCH = /* glsl */ `
  vec3 milkyWay(sampler2D tex, vec3 d, float K, float gain) {
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31831 + 0.5);
    vec3 c = texture2D(tex, uv).rgb;
    return gain * vec3(asinh(c.r * K), asinh(c.g * K), asinh(c.b * K)) / asinh(K);
  }
`;

interface BodyView {
  id: string;
  mesh: THREE.Mesh;
  label: CSS2DObject;
  trail: THREE.Line;
  trailPos: Float32Array;
  trailN: number;
  colorKey: string;
  glow?: THREE.Sprite;
  light?: THREE.PointLight;
}

export class Cosmos extends Realm {
  readonly id: RealmId = 'cosmos';
  /** build the Milky Way / galaxy-field layers (off for hypothetical universes) */
  protected cosmic = true;
  /** wrap the Sun in real solar imagery (off where the star is not our Sun) */
  protected starImagery = true;
  controlMode = 'orbit' as const;
  sim = new NBody();
  private defs: BodyDef[] = [];
  private epoch = -1;
  private revision = 0;
  private views = new Map<string, BodyView>();
  private system = new THREE.Group();
  private sky = makeSkyDome();
  private bh!: THREE.Mesh;
  private bhMat!: THREE.ShaderMaterial;
  private bhOn = false;
  private bhFade = 0;
  private timeScale = 0.5;
  private paused = false;
  private trails = true;
  private e0 = 0;
  private centerIdx = 0;
  private stepsLastFrame = 0;
  private worldId?: string;

  resetForWorld() {
    super.resetForWorld();
    this.epoch = -1;
    this.revision = -1;
    this.grabbed = undefined;
    this.focusAstro = undefined;
  }

  protected build() {
    this.look = { exposure: 1.0, bloom: [0.28, 0.5, 1.2], contrast: 1.04, saturation: 1.0, shadows: '#040818', highlights: '#fff4e8', vignette: 0.24, godRays: 0 };
    const su = this.sky.uniforms;
    su.uHorizon.value.set('#04050c'); su.uTop.value.set('#010104'); su.uBottom.value.set('#010104');
    su.uNebA.value.set('#3a2a7a'); su.uNebB.value.set('#103e6a'); su.uNebula.value = 0.35; su.uBand.value = 1.1; su.uStars.value = 1.3;
    this.starfield = makeStarfield(QUALITY.low ? 3000 : 6000, 900, 1.2);
    this.scene.add(this.sky.mesh, this.starfield, this.system);
    if (this.cosmic) this.initCosmic();
    // the real sky: Milky Way panorama (Solar System Scope, from ESO/NASA imagery)
    const mw = assets.space('8k_stars_milky_way.jpg');
    if (mw) {
      // The panorama is stored nearly linear (mean ≈ 1/255): apply an astrophotography asinh
      // stretch so the faint galactic band shows without blowing out the stars.
      const skyMat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: mw }, uK: { value: 6 }, uGain: { value: 0.55 } },
        side: THREE.BackSide, depthWrite: false,
        vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
        fragmentShader: `uniform sampler2D uMap; uniform float uK, uGain; varying vec3 vD;
          ${SKY_STRETCH}
          void main(){ vec3 d = normalize(vD); gl_FragColor = vec4(milkyWay(uMap, d, uK, uGain), 1.0); }`,
      });
      this.skySphere = new THREE.Mesh(new THREE.SphereGeometry(1500, 64, 32), skyMat);
      this.skySphere.frustumCulled = false;
      this.skySphere.renderOrder = -10;
      this.skySphere.rotation.set(0.42, 0, 0.3);
      this.scene.add(this.skySphere);
      this.sky.mesh.visible = false;
    }
    this.scene.add(new THREE.AmbientLight('#1a2030', 0.25));

    // Black hole: a sphere around the camera; the fragment shader integrates
    // photon paths in the Schwarzschild metric (units: r_s = 1).
    this.bhMat = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uFade: { value: 0 }, uScale: { value: 0.85 }, uSky: { value: assets.space('8k_stars_milky_way.jpg') }, uHasSky: { value: assets.space('8k_stars_milky_way.jpg') ? 1 : 0 } },
      side: THREE.BackSide, depthWrite: false, depthTest: false, transparent: true,
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; gl_Position.z = gl_Position.w*0.999; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCam; uniform float uTime, uFade, uScale, uHasSky; uniform sampler2D uSky; varying vec3 vW;
        ${NOISE_GLSL}
        ${SKY_STRETCH}
        vec3 stars(vec3 d){
          vec3 c = vec3(0.0);
          for (int k = 0; k < 2; k++) {
            float sc = k == 0 ? 220.0 : 520.0;
            vec3 p = floor(d*sc); float h = hash(p + float(k)*17.0);
            vec3 f = fract(d*sc) - 0.5;
            float star = smoothstep(0.995, 1.0, h) * smoothstep(0.35, 0.0, length(f));
            c += star * mix(vec3(0.7,0.8,1.0), vec3(1.0,0.85,0.7), hash(p*3.1)) * (k == 0 ? 3.0 : 1.4);
          }
          float n = fbm(d*2.6 + 3.0), n2 = fbm(d*5.5 - 1.0);
          c += vec3(0.12,0.22,0.55)*pow(n, 2.6)*1.2 + vec3(0.5,0.18,0.35)*pow(n2, 4.0)*1.4;
          return c;
        }
        void main(){
          vec3 ro = uCam / uScale;
          vec3 rd = normalize(vW - uCam);
          vec3 p = ro, v = rd;
          vec3 h = cross(p, v); float h2 = dot(h, h);
          vec3 col = vec3(0.0); float alpha = 0.0; float minR = 1e4;
          bool captured = false;
          for (int i = 0; i < ${QUALITY.blackHoleSteps}; i++) {
            float r = length(p);
            minR = min(minR, r);
            if (r < 1.0) { captured = true; break; }
            if (r > 120.0 && dot(p, v) > 0.0) break;
            float dt = clamp(0.06*r, 0.015, 1.5);
            vec3 pPrev = p;
            // null geodesic in Schwarzschild spacetime: d²x/dλ² = −(3/2) h² x / r⁵
            v += -1.5*h2*p/pow(r, 5.0)*dt; p += v*dt;
            if (pPrev.y*p.y < 0.0) {
              vec3 q = mix(pPrev, p, pPrev.y/(pPrev.y - p.y));
              float rq = length(q.xz);
              if (rq > 3.0 && rq < 16.0) {
                float ang = atan(q.z, q.x);
                float omega = uTime * 2.2 / pow(rq, 1.5);                  // Keplerian shear
                float streak = fbm(vec3(rq*2.2, (ang + omega)*5.0, 0.0)) * 0.7 + fbm(vec3(rq*7.0, (ang+omega)*14.0, 1.0)) * 0.5;
                float temp = pow(3.0/rq, 0.75);                           // thin disk T ∝ r^-3/4
                vec3 hot = mix(vec3(1.0,0.42,0.12), vec3(1.0,0.93,0.82), smoothstep(0.35, 0.95, temp));
                vec3 vel = normalize(vec3(-q.z, 0.0, q.x));
                float dop = pow(max(0.15, 1.0 + 0.7*dot(vel, -rd)), 3.0);  // relativistic beaming (approx.)
                float edge = smoothstep(3.0, 3.4, rq) * smoothstep(16.0, 9.0, rq);
                float a = edge * clamp(0.35 + streak*0.95, 0.0, 1.0);
                col += (1.0-alpha) * hot * a * temp * temp * 2.4 * dop;
                alpha += (1.0-alpha) * a * 0.92;
                if (alpha > 0.985) break;
              }
            }
          }
          if (!captured) {
            vec3 d = normalize(v);
            vec3 bg = stars(d);
            if (uHasSky > 0.5) {
              // the real Milky Way, seen along the BENT ray — this is gravitational lensing of actual sky imagery
              bg = milkyWay(uSky, d, 6.0, 0.55) + bg * 0.08;
            }
            col += (1.0-alpha) * bg;
          }
          // thin photon ring at the edge of the shadow (rays that skimmed r ≈ 1.5 r_s)
          col += (1.0-alpha) * vec3(1.0,0.82,0.6) * exp(-pow((minR-1.52)/0.05, 2.0)) * 2.5 * float(!captured);
          gl_FragColor = vec4(col, uFade);
        }`,
    });
    this.bh = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), this.bhMat);
    this.bh.frustumCulled = false;
    this.bh.renderOrder = 10;
    this.bh.visible = false;
    this.scene.add(this.bh);
  }

  private planetTexture(def: BodyDef): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d')!;
    const base = new THREE.Color(def.color);
    const gas = def.mass > 1e-5;
    let seed = [...def.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 9973;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < 256; y++) {
      const band = gas ? Math.sin(y * 0.18 + r() * 0.4) * 0.1 + Math.sin(y * 0.055) * 0.12 + Math.sin(y * 0.6) * 0.03 : 0;
      for (let x = 0; x < 512; x += 2) {
        const n = gas ? band + (r() - 0.5) * 0.04 : (r() - 0.5) * 0.25;
        const col = base.clone().offsetHSL(0, 0, n);
        g.fillStyle = `#${col.getHexString()}`;
        g.fillRect(x, y, 2, 1);
      }
    }
    if (def.id === 'earth') {
      g.fillStyle = '#3e8f4a';
      for (let i = 0; i < 40; i++) { g.beginPath(); g.ellipse(r() * 512, 40 + r() * 176, 14 + r() * 50, 8 + r() * 26, r() * 3, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 60; i++) { g.beginPath(); g.ellipse(r() * 512, r() * 256, 20 + r() * 60, 3 + r() * 6, 0, 0, 7); g.fill(); }
      g.fillStyle = '#f2f6ff';
      g.fillRect(0, 0, 512, 14); g.fillRect(0, 242, 512, 14);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private makeView(def: BodyDef): BodyView {
    let mesh: THREE.Mesh;
    let glow: THREE.Sprite | undefined, light: THREE.PointLight | undefined;
    if (def.kind === 'star') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(def.radius, 96, 64),
        new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(def.color) }, uMap: { value: def.id === 'sun' && this.starImagery ? assets.space('2k_sun.jpg') : null }, uHas: { value: def.id === 'sun' && this.starImagery && !!assets.space('2k_sun.jpg') ? 1 : 0 } },
          vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; varying vec2 vUv; void main(){ vP = position; vUv = uv; vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
          fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform sampler2D uMap; uniform float uHas; varying vec3 vP; varying vec3 vN; varying vec3 vV; varying vec2 vUv; ${NOISE_GLSL}
            void main(){
              vec3 q = normalize(vP);
              float gran = fbm(q*14.0 + uTime*0.08);                // convection cells
              float spots = smoothstep(0.72, 0.8, fbm(q*3.0 + 11.0)); // sunspots
              float mu = max(dot(vN, vV), 0.0);
              float limb = 0.35 + 0.65*pow(mu, 0.6);                  // limb darkening
              vec3 c = uColor * (1.6 + gran*1.4) * limb * (1.0 - spots*0.75);
              if (uHas > 0.5) {
                // real solar imagery, slowly boiling via flow distortion
                vec2 flow = vec2(fbm(q*6.0 + uTime*0.05), fbm(q*6.0 - uTime*0.04)) - 0.5;
                vec3 t1 = texture2D(uMap, vUv + flow*0.006 + vec2(uTime*0.0008, 0.0)).rgb;
                vec3 t2 = texture2D(uMap, vUv - flow*0.006).rgb;
                c = pow(mix(t1, t2, 0.5 + 0.5*sin(uTime*0.3)), vec3(1.2)) * vec3(3.4, 2.6, 1.9) * limb * (0.85 + gran*0.3);
              }
              c += vec3(1.0,0.6,0.25) * pow(1.0-mu, 3.0) * 0.6;
              gl_FragColor = vec4(c, 1.0); }`,
        }),
      );
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTexture(), color: def.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.scale.setScalar(def.radius * 3.4);
      (glow.material as THREE.SpriteMaterial).opacity = 0.4;
      mesh.add(glow);
      // sunlight in space is white (the Sun's yellow tint is an atmospheric effect on Earth)
      light = new THREE.PointLight(def.id === 'sun' && this.starImagery ? '#fff6ec' : def.color, 4.5, 0, 0);
      mesh.add(light);
      this.sunWorld = new THREE.Vector3();
    } else {
      const real = PLANET_MAPS[def.id] ? assets.space(PLANET_MAPS[def.id]) : null;
      const mat = real
        ? new THREE.MeshStandardMaterial({ map: real, roughness: def.id === 'earth' ? 0.62 : 0.9, metalness: 0 })
        : new THREE.MeshStandardMaterial({ map: this.planetTexture(def), bumpMap: this.planetTexture(def), bumpScale: def.mass > 1e-5 ? 0.2 : 2, roughness: def.id === 'earth' ? 0.55 : 0.85, metalness: 0 });
      mesh = new THREE.Mesh(new THREE.SphereGeometry(def.radius, 96, 64), mat);
      if (def.id === 'earth' && real) this.makeEarth(mesh, mat, def.radius);
      const atm = ATMOSPHERE[def.id];
      if (atm) {
        const shell = new THREE.Mesh(new THREE.SphereGeometry(def.radius * (def.id === 'earth' ? 1.035 : 1.055), 64, 40), new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(atm) }, uSun: { value: new THREE.Vector3() } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
          vertexShader: `varying vec3 vN; varying vec3 vW; varying vec3 vV; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
          fragmentShader: `uniform vec3 uColor; uniform vec3 uSun; varying vec3 vN; varying vec3 vW; varying vec3 vV;
            void main(){
              vec3 N = normalize(vN), V = normalize(vV), L = normalize(uSun - vW);
              float rim = pow(1.0 - abs(dot(N, V)), 3.5);
              float daylight = smoothstep(-0.2, 0.45, dot(N, L));
              float sunset = exp(-pow(dot(N,L)*5.0, 2.0));
              vec3 scatter = mix(uColor, vec3(0.65,0.19,0.045), sunset*0.6);
              gl_FragColor = vec4(scatter * 1.8, rim * (daylight + sunset*0.22) * 0.7); }`,
        }));
        shell.userData.atmosphere = true;
        mesh.add(shell);
      }
      if (def.id === 'saturn') {
        const ringTex = assets.space('2k_saturn_ring_alpha.png');
        const rg = new THREE.RingGeometry(def.radius * 1.24, def.radius * 2.27, 256, 1);
        const rp = rg.attributes.position as THREE.BufferAttribute, ruv = rg.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < rp.count; i++) ruv.setXY(i, (Math.hypot(rp.getX(i), rp.getY(i)) - def.radius * 1.24) / (def.radius * 1.03), 0.5);
        const ring = new THREE.Mesh(rg, ringTex
          ? new THREE.MeshStandardMaterial({ map: ringTex, alphaMap: ringTex, transparent: true, side: THREE.DoubleSide, roughness: 0.9, depthWrite: false })
          : new THREE.MeshBasicMaterial({ color: '#d8c89a', side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
        ring.rotation.x = -Math.PI / 2 + 0.45;
        mesh.add(ring);
      }
    }
    mesh.userData.bodyId = def.id;
    const el = document.createElement('div');
    el.className = 'label body-label';
    el.textContent = def.name;
    const label = new CSS2DObject(el);
    label.position.set(0, def.radius + 0.5, 0);
    mesh.add(label);
    const trailPos = new Float32Array(TRAIL * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const tc = new Float32Array(TRAIL * 3);
    const base = new THREE.Color(def.color);
    for (let i = 0; i < TRAIL; i++) { const k = Math.pow(1 - i / TRAIL, 1.6) * 0.8; tc.set([base.r * k, base.g * k, base.b * k], i * 3); }
    tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    tg.setDrawRange(0, 0);
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.frustumCulled = false;
    this.system.add(mesh, trail);
    return { id: def.id, mesh, label, trail, trailPos, trailN: 0, colorKey: def.color, glow, light };
  }

  /** Earth: city lights on the night side and a separate, drifting cloud layer. */
  private makeEarth(mesh: THREE.Mesh, mat: THREE.MeshStandardMaterial, radius: number) {
    const night = assets.space('2k_earth_nightmap.jpg');
    if (night) {
      mat.emissiveMap = night;
      mat.emissive = new THREE.Color('#ffd9a0');
      mat.emissiveIntensity = 0.65;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uSunView = this.sunView;
        sh.fragmentShader = 'uniform vec3 uSunView;\n' + sh.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float dayside = dot(normalize(vNormal), normalize(uSunView));
          totalEmissiveRadiance *= 1.0 - smoothstep(-0.25, 0.15, dayside);`,
        );
        sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', `
          #include <roughnessmap_fragment>
          // Ocean highlights are smoother than land. Derived from the day map,
          // this is a visual material mask, not an additional measured dataset.
          float ocean = smoothstep(0.015, 0.09, diffuseColor.b - max(diffuseColor.r, diffuseColor.g));
          roughnessFactor = mix(0.88, 0.28, ocean);
        `);
      };
    }
    const cloudsT = assets.space('2k_earth_clouds.jpg', false);
    if (cloudsT) {
      const clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.008, 96, 64), new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true, color: '#f1f5ff', roughness: 1, depthWrite: false, opacity: 0.85 }));
      clouds.userData.clouds = true;
      mesh.add(clouds);
    }
  }
  private sunView = { value: new THREE.Vector3(1, 0, 0) };
  private starfield!: THREE.Points;
  catalog: CatalogEntry[] = [];
  milkyWay?: MilkyWayModel;
  galaxies?: GalaxyField;
  /** which representation is shown: solar system, Milky Way model or real galaxy field */
  layer: 'solar' | 'galactic' | 'cosmic' = 'solar';
  private fade = { solar: 1, galactic: 0, cosmic: 0 };
  focusAstro?: string;

  private async initCosmic() {
    try {
      const r = await fetch('/assets/astro/catalog.json');
      if (!r.ok) return;
      this.catalog = (await r.json()).objects;
      this.milkyWay = new MilkyWayModel(this.catalog);
      this.galaxies = new GalaxyField(this.catalog);
      this.scene.add(this.milkyWay.group, this.galaxies.group);
      this.milkyWay.setOpacity(0, 600);
      this.galaxies.setOpacity(0, 600);
    } catch (e) {
      console.warn('cosmic layers unavailable', e);
    }
  }
  private skySphere?: THREE.Mesh;

  private rebuild(defs: BodyDef[]) {
    for (const v of this.views.values()) this.disposeView(v);
    this.views.clear();
    this.defs = defs.map((d) => ({ ...d }));
    this.sim.load(this.defs);
    for (const d of this.defs) this.views.set(d.id, this.makeView(d));
    this.e0 = this.sim.energy();
    this.centerIdx = this.sim.mostMassive();
  }

  private disposeView(v: BodyView) {
    this.system.remove(v.mesh, v.trail);
    v.label.element.remove();
    v.mesh.geometry.dispose();
    v.trail.geometry.dispose();
  }

  sync(state: WorldState, t: number) {
    super.sync(state, t);
    const c = state.cosmos;
    this.timeScale = c.timeScale;
    this.paused = c.paused;
    this.trails = c.trails;
    this.sim.gScale = state.env.cosmos.gravity;
    this.grabbed = c.grabbed;
    if (state.id !== this.worldId || c.epoch !== this.epoch) {
      this.worldId = state.id;
      this.epoch = c.epoch;
      this.revision = c.revision ?? 0;
      this.rebuild(c.bodies);
    } else if ((c.revision ?? 0) !== this.revision) {
      // bodies were moved by a command: reload positions & velocities from the authoritative state
      this.revision = c.revision ?? 0;
      this.defs = c.bodies.map((d) => ({ ...d }));
      this.sim.load(this.defs);
      this.e0 = this.sim.energy();
      this.centerIdx = this.sim.mostMassive();
      for (const v of this.views.values()) v.trailN = 0;
    } else {
      const ids = new Set(c.bodies.map((b) => b.id));
      const added = c.bodies.filter((b) => !this.views.has(b.id));
      const removed = [...this.views.keys()].filter((id) => !ids.has(id));
      if (added.length || removed.length) {
        // keep live positions for existing bodies, take state positions for new ones
        const live = this.sim.snapshot(this.defs).filter((d) => ids.has(d.id));
        for (const id of removed) { const v = this.views.get(id)!; this.disposeView(v); this.views.delete(id); }
        this.defs = [...live, ...added.map((a) => ({ ...a }))];
        this.sim.load(this.defs);
        for (const a of added) this.views.set(a.id, this.makeView(a));
        this.e0 = this.sim.energy();
        this.centerIdx = this.sim.mostMassive();
      }
      for (const b of c.bodies) {
        const i = this.sim.index(b.id);
        if (i >= 0 && this.sim.mass[i] !== b.mass) {
          this.sim.mass[i] = b.mass;
          this.e0 = this.sim.energy();
          this.centerIdx = this.sim.mostMassive();
        }
        const v = this.views.get(b.id);
        const base = (v?.mesh.geometry as THREE.SphereGeometry | undefined)?.parameters?.radius;
        if (v && base) v.mesh.scale.setScalar(b.radius / base);
        if (v && v.colorKey !== b.color) {
          v.colorKey = b.color;
          const m = v.mesh.material as any;
          if (m.map) { m.map = this.planetTexture(b); m.needsUpdate = true; }
          (v.trail.material as THREE.LineBasicMaterial).color.set(b.color);
        }
      }
    }
    this.bhOn = c.blackHole;
  }

  /** Copy live positions/velocities back into a state's body list (for saving / adding bodies). */
  snapshotBodies(bodies: BodyDef[]): BodyDef[] {
    return bodies.map((b) => {
      const i = this.sim.index(b.id);
      return i < 0 ? b : { ...b, pos: this.sim.getPos(i), vel: this.sim.getVel(i) };
    });
  }

  protected applyEnv(e: Env) {
    this.sky.uniforms.uTintAmt.value = e.skyColor ? 0.5 : 0;
    if (e.skyColor) this.sky.uniforms.uTint.value.set(e.skyColor);
  }

  /**
   * Display position: the heaviest body is placed by compressing its distance from the
   * origin; everything else is compressed relative to it. Local structure stays readable
   * and a moved star visibly moves.
   */
  displayPos(i: number, out = new THREE.Vector3()) {
    const c = this.centerIdx;
    const pc = this.sim.getPos(c);
    const C = compress(pc);
    if (i === c) return out.set(C[0], C[1], C[2]);
    const rel = compress([this.sim.pos[i * 3] - pc[0], this.sim.pos[i * 3 + 1] - pc[1], this.sim.pos[i * 3 + 2] - pc[2]]);
    return out.set(C[0] + rel[0], C[1] + rel[1], C[2] + rel[2]);
  }

  /** Inverse of displayPos for a held body: a display-space point → simulation AU. */
  displayToAU(id: string, p: THREE.Vector3): [number, number, number] {
    const i = this.sim.index(id), c = this.centerIdx;
    if (i === c) return decompress([p.x, p.y, p.z]);
    const pc = this.sim.getPos(c), C = compress(pc);
    const rel = decompress([p.x - C[0], p.y - C[1], p.z - C[2]]);
    return [pc[0] + rel[0], pc[1] + rel[1], pc[2] + rel[2]];
  }

  /** While held: place the body (in sandbox a held star carries its planets). */
  holdAt(id: string, au: [number, number, number], sandbox: boolean) {
    const i = this.sim.index(id);
    if (i < 0) return;
    const old = this.sim.getPos(i);
    const d = [au[0] - old[0], au[1] - old[1], au[2] - old[2]];
    if (sandbox && i === this.centerIdx) {
      for (let k = 0; k < this.sim.n; k++) for (let a = 0; a < 3; a++) this.sim.pos[k * 3 + a] += d[a];
    } else {
      for (let a = 0; a < 3; a++) { this.sim.pos[i * 3 + a] = au[a]; this.sim.vel[i * 3 + a] = this.sim.vel[this.centerIdx * 3 + a]; }
    }
    for (const v of this.views.values()) v.trailN = 0;
  }

  grabbed?: string;

  update(ctx: FrameCtx) {
    super.update(ctx);
    this.sky.uniforms.uTime.value = ctx.t;
    if (this.skySphere && ctx.active) this.skySphere.position.copy(ctx.camera.position);
    if (!this.paused && !ctx.frozen && (ctx.active || ctx.dt > 0)) {
      const years = this.timeScale * ctx.dt;
      this.stepsLastFrame = this.sim.advance(years, 0.0005, ctx.active ? 800 : 120);
    }
    const p = new THREE.Vector3();
    for (const [id, v] of this.views) {
      const i = this.sim.index(id);
      if (i < 0) continue;
      this.displayPos(i, p);
      v.mesh.position.copy(p);
      v.mesh.rotation.y += ctx.dt * 0.6;
      if (this.grabbed === id) v.mesh.scale.multiplyScalar(1 + Math.sin(ctx.t * 6) * 0.004);
      if (v.light && this.sunWorld) this.sunWorld.copy(p);
      const mat = v.mesh.material as any;
      if (mat.uniforms?.uTime) mat.uniforms.uTime.value = ctx.t;
      v.trail.visible = this.trails && !document.body.classList.contains('cinema');
      if (this.trails && !ctx.frozen && !this.paused) {
        // ring-buffer shift (cheap at this size)
        const last = v.trailN > 0 ? new THREE.Vector3(v.trailPos[0], v.trailPos[1], v.trailPos[2]) : null;
        if (!last || last.distanceToSquared(p) > 0.0025) {
          v.trailPos.copyWithin(3, 0, (TRAIL - 1) * 3);
          v.trailPos[0] = p.x; v.trailPos[1] = p.y; v.trailPos[2] = p.z;
          v.trailN = Math.min(TRAIL, v.trailN + 1);
          v.trail.geometry.setDrawRange(0, v.trailN);
          v.trail.geometry.attributes.position.needsUpdate = true;
        }
      }
    }
    // ——— layer crossfade (solar system ↔ Milky Way ↔ galaxy field) ———
    const k = Math.min(1, ctx.rdt * 1.6);
    for (const id of ['solar', 'galactic', 'cosmic'] as const) this.fade[id] += ((this.layer === id ? 1 : 0) - this.fade[id]) * k;
    const proj = innerHeight / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
    this.system.visible = this.fade.solar > 0.02 && this.bhFade < 0.98;
    this.starfield.visible = this.fade.solar > 0.02;
    if (this.skySphere) this.skySphere.visible = this.fade.solar > 0.02;
    this.milkyWay?.setOpacity(this.fade.galactic, proj);
    this.galaxies?.setOpacity(this.fade.cosmic, proj);
    if (this.milkyWay) { this.milkyWay.focusId = this.focusAstro; this.milkyWay.declutter(ctx.camera); }
    if (this.galaxies) { this.galaxies.focusId = this.focusAstro; this.galaxies.declutter(ctx.camera); }
    for (const v of this.views.values()) v.label.visible = this.fade.solar > 0.5 && this.bhFade < 0.5;
    const sunP = this.sunWorld ?? new THREE.Vector3();
    // sun direction in view space (for Earth's night lights), clouds drift
    const earth = this.views.get('earth');
    if (earth) {
      this.sunView.value.copy(sunP).sub(earth.mesh.position).normalize().transformDirection(ctx.camera.matrixWorldInverse);
      for (const c of earth.mesh.children) if (c.userData.clouds) c.rotation.y += ctx.dt * 0.15;
    }
    for (const v of this.views.values()) for (const c of v.mesh.children) if (c.userData.atmosphere) ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uSun.value.copy(sunP);
    // Black-hole crossfade
    this.bhFade += ((this.bhOn ? 1 : 0) - this.bhFade) * Math.min(1, ctx.rdt * 1.5);
    this.bh.visible = this.bhFade > 0.01;
    this.system.visible = this.fade.solar > 0.02 && this.bhFade < 0.98;
    this.bhMat.uniforms.uFade.value = this.bhFade;
    this.look.bloom = this.bhOn ? [0.3, 0.5, 1.2] : [0.28, 0.5, 1.2];
    this.look.godRays = 0;
    this.bhMat.uniforms.uTime.value = ctx.t;
    this.bhMat.uniforms.uCam.value.copy(ctx.camera.position);
    this.bh.position.copy(ctx.camera.position);
  }

  focusPoint(kind: string, id: string) {
    if (kind === 'body') {
      const i = this.sim.index(id);
      if (i >= 0) return this.displayPos(i);
    }
    return super.focusPoint(kind, id);
  }

  /** observer's apparent height in display units (drives camera distance, speed and reach) */
  observerH = 0.0025;

  /**
   * Apparent size → camera. Human-sized: you hover just above Earth. Growing:
   * the camera pulls back so bodies keep their apparent relation to your size;
   * past planet scale the Sun becomes the anchor. Mass and physics are untouched.
   */
  applyObserver(size: number, rig: CameraRig, focus?: string) {
    const obj = focus ? resolveAstro(focus) : undefined;
    this.focusAstro = obj?.id;
    this.layer = !this.cosmic ? 'solar' : obj ? (obj.where === 'milky_way' ? 'galactic' : 'cosmic') : cosmicLayer(size);
    if (this.layer !== 'solar') {
      // each layer has its own units: 100 pc (galactic) or 1 Mpc (cosmic)
      const unitM = this.layer === 'galactic' ? 3.0857e18 : 3.0857e22;
      const L = this.layer === 'galactic' ? this.milkyWay : this.galaxies;
      const target = (obj && L?.positions.get(obj.id)) || (this.layer === 'galactic' && this.milkyWay ? this.milkyWay.centre : new THREE.Vector3());
      const radius = Math.min(1500, Math.max(0.004, (size / unitM) * (obj ? 0.6 : this.layer === 'cosmic' ? 0.32 : 0.55)));
      if (rig.mode !== 'orbit') rig.setOrbit(new THREE.Vector3(), rig.camera.position.clone());
      rig.speedScale = radius * 0.2;
      rig.target.copy(target);
      rig.radius = radius;
      rig.phi = obj ? 1.25 : this.layer === 'galactic' ? 0.75 : 1.1;
      rig.follow = undefined;
      return;
    }
    const H = cosmosDisplayHeight(size);
    this.observerH = H;
    const anchor = size < 3e8 && this.sim.index('earth') >= 0 ? 'earth' : this.defs.find((d) => d.kind === 'star')?.id ?? this.defs[0]?.id;
    if (!anchor) return;
    const bodyR = this.bodyRadius(anchor);
    const dist = Math.max(bodyR * 1.08 + H * 2.5, H * 3);
    if (rig.mode !== 'orbit') rig.setOrbit(new THREE.Vector3(), rig.camera.position.clone());
    rig.speedScale = Math.max(0.02, H);
    const p = this.focusPoint('body', anchor) ?? new THREE.Vector3();
    rig.focusOn(p, dist, () => this.focusPoint('body', anchor));
  }

  bodyRadius(id: string) {
    return this.defs.find((d) => d.id === id)?.radius ?? 1;
  }

  private astroCard(s: WorldState): InfoCard {
    const o = this.focusAstro ? this.catalog.find((c) => c.id === this.focusAstro) : undefined;
    const meta = o ? resolveAstro(o.id) : undefined;
    if (o && meta) {
      const img = o.images[0];
      return {
        title: o.name,
        mode: 'SCIENTIFIC REALITY',
        subtitle: `${o.kind} · ${formatDistance(meta)} away${o.where === 'milky_way' ? ' · inside the Milky Way' : ''}.`,
        accuracy: [
          { tag: 'MEASURED', text: `Sky position from SIMBAD (RA ${o.ra.toFixed(3)}°, Dec ${o.dec.toFixed(3)}°; galactic l ${o.l.toFixed(2)}°, b ${o.b.toFixed(2)}°). Distance: published estimate (${o.ref}).${img ? ` Image: ${img.telescope}.` : ''}` },
          { tag: 'ARTISTIC', text: img ? 'Shown as a camera-facing impostor of the real telescope image — the true 3-D shape and orientation are not known from a single image (a reconstruction).' : 'No telescope image is bundled for this object; it is drawn as a procedural stand-in (a reconstruction).' },
        ],
        stats: [{ label: 'Distance', value: formatDistance(meta) }, { label: 'Size (approx.)', value: `${o.size_kpc >= 1 ? o.size_kpc + ' kpc' : (o.size_kpc * 1000).toFixed(o.size_kpc < 0.01 ? 1 : 0) + ' pc'}` }, { label: 'SIMBAD type', value: o.simbadType || '—' }, { label: 'You are', value: formatLength(s.observer?.size ?? 1.7) }],
        extraHtml: img ? `<figure class="astro-img"><img src="/assets/astro/${img.file}" alt="${escapeHtml(img.title)}"/><figcaption>${escapeHtml(img.title)} — ${escapeHtml(img.credit)} (${img.license}) · <a href="${img.page}" target="_blank" rel="noopener">source</a></figcaption></figure>` : '',
      };
    }
    if (this.layer === 'galactic') return {
      title: 'The Milky Way',
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'Our galaxy: a barred spiral about 30 kpc across, holding a few hundred billion stars. The Sun sits 8.2 kpc from the centre, between two arms.',
      accuracy: [
        { tag: 'MODEL', text: 'Reconstructed from published structure: exponential disk (scale length 2.6 kpc), four spiral arms (pitch ≈ 12°), central bar (27°), dust lanes and H II regions. The real Milky Way has never been photographed from outside.' },
        { tag: 'MEASURED', text: 'The nebulae and clusters shown are placed at their measured sky positions and published distances (SIMBAD; Gaia-era estimates).' },
        { tag: 'ARTISTIC', text: 'Individual stars are statistical samples, not real stars; colours are stylised.' },
      ],
      stats: [{ label: 'You are', value: formatLength(s.observer?.size ?? 1.7) }, { label: 'Sun → centre', value: '8.18 kpc (GRAVITY 2019)' }],
    };
    return {
      title: 'The nearby universe · 2MASS Redshift Survey',
      mode: 'SCIENTIFIC REALITY',
      subtitle: `${(this.galaxies?.count ?? 0).toLocaleString()} real galaxies around the Milky Way, out to ~1.5 billion light-years. The filaments and walls are the cosmic web; the empty band is where our own galaxy’s dust hides the sky.`,
      accuracy: [
        { tag: 'MEASURED', text: 'Sky positions, near-infrared brightness, sizes and morphological types from the 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26).' },
        { tag: 'MODEL', text: 'Distances from redshift via Hubble’s law (H₀ = 70 km/s/Mpc). Galaxies’ own motions smear clusters along the line of sight (“fingers of God”).' },
        { tag: 'ARTISTIC', text: 'Each galaxy is a glowing point sized by its measured extent; named galaxies use telescope-image impostors.' },
      ],
      stats: [{ label: 'Galaxies', value: (this.galaxies?.count ?? 0).toLocaleString() }, { label: 'You are', value: formatLength(s.observer?.size ?? 1.7) }],
    };
  }

  info(s: WorldState): InfoCard {
    if (this.layer !== 'solar') return this.astroCard(s);
    const drift = this.e0 ? Math.abs((this.sim.energy() - this.e0) / this.e0) : 0;
    const center = this.sim.mostMassive();
    const rows = this.defs
      .map((d) => ({ d, i: this.sim.index(d.id) }))
      .filter(({ i }) => i >= 0 && i !== center)
      .slice(0, 9)
      .map(({ d, i }) => {
        const el = this.sim.orbitalElements(i, center);
        const bound = el.a > 0 && el.e < 1;
        return `<tr><td><i style="background:${d.color}"></i>${d.name}</td><td>${(this.sim.mass[i] / 3.003e-6).toPrecision(3)}</td><td>${bound ? el.a.toFixed(2) : '—'}</td><td>${bound ? el.e.toFixed(3) : 'unbound'}</td><td>${bound ? el.period.toFixed(2) : '—'}</td></tr>`;
      })
      .join('');
    if (s.cosmos.blackHole) {
      return {
        title: 'Schwarzschild Black Hole',
        mode: 'SCIENTIFIC REALITY',
        subtitle: 'Light passing near the hole is bent by spacetime curvature. The dark disc is the shadow: rays that fall in never come back.',
        accuracy: [
          { tag: 'SIMULATION', text: 'Each pixel integrates a photon path through the Schwarzschild metric (null geodesic, d²x/dλ² = −1.5 h² x / r⁵), so lensing, the shadow and the warped far side of the disk are computed, not painted.' },
          { tag: 'MODEL', text: 'Non-rotating, uncharged hole. Thin disk from the ISCO (3 r_s) outward, temperature ∝ r^−3/4.' },
          { tag: 'ARTISTIC', text: 'Disk turbulence, colours, brightness and Doppler beaming are approximations; there is no gravitational redshift or time dilation in the colours.' },
        ],
        stats: [{ label: 'Shadow radius', value: '≈ 2.6 r_s' }, { label: 'Photon sphere', value: '1.5 r_s' }, { label: 'ISCO', value: '3 r_s' }],
      };
    }
    return {
      title: s.cosmos.preset === 'binary_star' ? 'Binary Star System' : 'Planetary System',
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'Every body pulls on every other body. Change a mass and the orbits respond — computed live, not animated.',
      accuracy: [
        { tag: 'SIMULATION', text: 'Newtonian N-body gravity, velocity-Verlet integrator, units AU / years / M☉ (G = 4π²). Real planetary masses & semi-major axes.' },
        { tag: 'MODEL', text: 'Planets start on circular, coplanar orbits (real ones are slightly eccentric and inclined). No relativity, no moons.' },
        { tag: 'ARTISTIC', text: 'Distances are compressed (∝√r) and planets drawn ~1000× too large so everything fits on screen. Surface textures are stylised.' },
      ],
      stats: [
        { label: 'Simulated time', value: `${this.sim.time.toFixed(2)} yr` },
        { label: 'Rate', value: s.cosmos.paused ? 'paused' : `${s.cosmos.timeScale} yr/s${s.time.scale !== 1 ? ` × ${s.time.scale}` : ''}` },
        { label: 'Gravity (G)', value: `${s.env.cosmos.gravity}× real` },
        { label: 'Energy drift', value: drift.toExponential(1) },
        { label: 'Integrator steps/frame', value: String(this.stepsLastFrame) },
      ],
      extraHtml: `<table class="orbits"><thead><tr><th>body</th><th>M⊕</th><th>a (AU)</th><th>e</th><th>P (yr)</th></tr></thead><tbody>${rows}</tbody></table>`,
    };
  }
}

const ATMOSPHERE: Record<string, string> = { earth: '#5aa0ff', venus: '#ffd28a', mars: '#ff9a6a', jupiter: '#ffe0b0', saturn: '#ffe8b8', uranus: '#9ff0ff', neptune: '#5a7aff', tatooine: '#ffc890' };

let coronaTex: THREE.Texture | undefined;
function coronaTexture() {
  if (coronaTex) return coronaTex;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(256, 256, 40, 256, 256, 256);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,230,190,0.55)');
  grd.addColorStop(0.45, 'rgba(255,170,90,0.12)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 512, 512);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2, len = 120 + Math.random() * 130;
    const lg = g.createLinearGradient(256, 256, 256 + Math.cos(a) * len, 256 + Math.sin(a) * len);
    lg.addColorStop(0, 'rgba(255,220,170,0.10)');
    lg.addColorStop(1, 'rgba(255,220,170,0)');
    g.strokeStyle = lg;
    g.lineWidth = 1 + Math.random() * 2.5;
    g.beginPath(); g.moveTo(256, 256); g.lineTo(256 + Math.cos(a) * len, 256 + Math.sin(a) * len); g.stroke();
  }
  return (coronaTex = new THREE.CanvasTexture(c));
}

/** Real planetary maps (Solar System Scope, CC BY 4.0, from NASA imagery). */
const PLANET_MAPS: Record<string, string> = {
  mercury: '2k_mercury.jpg', venus: '2k_venus_atmosphere.jpg', earth: '8k_earth_daymap.jpg', mars: '2k_mars.jpg',
  jupiter: '2k_jupiter.jpg', saturn: '2k_saturn.jpg', uranus: '2k_uranus.jpg', neptune: '2k_neptune.jpg',
};
