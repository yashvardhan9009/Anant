import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Realm, InfoCard, FrameCtx } from '../engine/Realm';
import { makeSkyDome, makeStarfield, NOISE_GLSL } from '../engine/fx';
import { radialTexture } from './Atom';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { QUALITY } from '../engine/quality';
import type { WorldState, Env } from '../../shared/worldState';
import { NBody, BodyDef, displayRadius } from '../../shared/physics';

const TRAIL = 700;

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
  readonly id = 'cosmos' as const;
  controlMode = 'orbit' as const;
  sim = new NBody();
  private defs: BodyDef[] = [];
  private epoch = -1;
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

  protected build() {
    this.look = { exposure: 1.0, bloom: [0.6, 0.6, 0.8], contrast: 1.12, saturation: 1.05, shadows: '#040818', highlights: '#fff0dc', vignette: 0.7, godRays: 0.3 };
    const su = this.sky.uniforms;
    su.uHorizon.value.set('#04050c'); su.uTop.value.set('#010104'); su.uBottom.value.set('#010104');
    su.uNebA.value.set('#3a2a7a'); su.uNebB.value.set('#103e6a'); su.uNebula.value = 0.35; su.uBand.value = 1.1; su.uStars.value = 1.3;
    this.scene.add(this.sky.mesh, makeStarfield(9000, 900, 1.3), this.system);
    this.scene.add(new THREE.AmbientLight('#1a2030', 0.25));

    // Black hole: a sphere around the camera; the fragment shader integrates
    // photon paths in the Schwarzschild metric (units: r_s = 1).
    this.bhMat = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uFade: { value: 0 }, uScale: { value: 3 } },
      side: THREE.BackSide, depthWrite: false, depthTest: false, transparent: true,
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; gl_Position.z = gl_Position.w*0.999; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCam; uniform float uTime, uFade, uScale; varying vec3 vW;
        ${NOISE_GLSL}
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
            if (r > 80.0 && dot(p, v) > 0.0) break;
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
                col += (1.0-alpha) * hot * a * temp * temp * 9.0 * dop;
                alpha += (1.0-alpha) * a * 0.92;
                if (alpha > 0.985) break;
              }
            }
          }
          if (!captured) col += (1.0-alpha) * stars(normalize(v));
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
          uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(def.color) } },
          vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
          fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec3 vP; varying vec3 vN; varying vec3 vV; ${NOISE_GLSL}
            void main(){
              vec3 q = normalize(vP);
              float gran = fbm(q*14.0 + uTime*0.08);                // convection cells
              float spots = smoothstep(0.72, 0.8, fbm(q*3.0 + 11.0)); // sunspots
              float mu = max(dot(vN, vV), 0.0);
              float limb = 0.35 + 0.65*pow(mu, 0.6);                  // limb darkening
              vec3 c = uColor * (1.6 + gran*1.4) * limb * (1.0 - spots*0.75);
              c += vec3(1.0,0.6,0.25) * pow(1.0-mu, 3.0) * 0.6;
              gl_FragColor = vec4(c, 1.0); }`,
        }),
      );
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTexture(), color: def.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.scale.setScalar(def.radius * 4.2);
      (glow.material as THREE.SpriteMaterial).opacity = 0.55;
      mesh.add(glow);
      light = new THREE.PointLight(def.color, 4, 0, 0);
      if (!QUALITY.low) {
        const flare = new Lensflare();
        flare.addElement(new LensflareElement(flareTexture('main'), 220, 0, new THREE.Color(def.color)));
        flare.addElement(new LensflareElement(flareTexture('ring'), 70, 0.45));
        flare.addElement(new LensflareElement(flareTexture('ring'), 120, 0.7));
        flare.addElement(new LensflareElement(flareTexture('ring'), 50, 0.95));
        light.add(flare);
      }
      mesh.add(light);
      this.sunWorld = new THREE.Vector3();
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(def.radius, 64, 40), new THREE.MeshStandardMaterial({ map: this.planetTexture(def), bumpMap: this.planetTexture(def), bumpScale: def.mass > 1e-5 ? 0.2 : 2, roughness: def.id === 'earth' ? 0.55 : 0.85, metalness: 0 }));
      const atm = ATMOSPHERE[def.id];
      if (atm) {
        const shell = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 1.12, 48, 32), new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(atm) }, uSun: { value: new THREE.Vector3() } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
          vertexShader: `varying vec3 vN; varying vec3 vW; varying vec3 vV; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
          fragmentShader: `uniform vec3 uColor; uniform vec3 uSun; varying vec3 vN; varying vec3 vW; varying vec3 vV;
            void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float lit = smoothstep(-0.3, 0.6, dot(-vN, normalize(uSun - vW)));
              gl_FragColor = vec4(uColor * f * lit * 2.2, f * lit); }`,
        }));
        shell.userData.atmosphere = true;
        mesh.add(shell);
      }
      if (def.id === 'saturn') {
        const ring = new THREE.Mesh(new THREE.RingGeometry(def.radius * 1.3, def.radius * 2.3, 64), new THREE.MeshBasicMaterial({ color: '#d8c89a', side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
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
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.frustumCulled = false;
    this.system.add(mesh, trail);
    return { id: def.id, mesh, label, trail, trailPos, trailN: 0, colorKey: def.color, glow, light };
  }

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
    if (c.epoch !== this.epoch) {
      this.epoch = c.epoch;
      this.rebuild(c.bodies);
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

  /** Display position: positions relative to the heaviest body, radially compressed for visibility. */
  displayPos(i: number, out = new THREE.Vector3()) {
    const c = this.centerIdx;
    const dx = this.sim.pos[i * 3] - this.sim.pos[c * 3], dy = this.sim.pos[i * 3 + 1] - this.sim.pos[c * 3 + 1], dz = this.sim.pos[i * 3 + 2] - this.sim.pos[c * 3 + 2];
    const r = Math.hypot(dx, dy, dz);
    if (r < 1e-9) return out.set(0, 0, 0);
    const k = displayRadius(r) / r;
    return out.set(dx * k, dy * k, dz * k);
  }

  update(ctx: FrameCtx) {
    super.update(ctx);
    this.sky.uniforms.uTime.value = ctx.t;
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
      if (v.light && this.sunWorld) this.sunWorld.copy(p);
      const mat = v.mesh.material as any;
      if (mat.uniforms?.uTime) mat.uniforms.uTime.value = ctx.t;
      v.trail.visible = this.trails;
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
    const sunP = this.sunWorld ?? new THREE.Vector3();
    for (const v of this.views.values()) for (const c of v.mesh.children) if (c.userData.atmosphere) ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uSun.value.copy(sunP);
    // Black-hole crossfade
    this.bhFade += ((this.bhOn ? 1 : 0) - this.bhFade) * Math.min(1, ctx.rdt * 1.5);
    this.bh.visible = this.bhFade > 0.01;
    this.system.visible = this.bhFade < 0.98;
    this.bhMat.uniforms.uFade.value = this.bhFade;
    this.look.bloom = this.bhOn ? [0.9, 0.7, 0.7] : [0.35, 0.4, 1.4];
    this.look.godRays = this.bhOn ? 0 : 0.3;
    this.bhMat.uniforms.uTime.value = ctx.t;
    this.bhMat.uniforms.uCam.value.copy(ctx.camera.position);
    this.bh.position.copy(ctx.camera.position);
    for (const v of this.views.values()) v.label.visible = this.bhFade < 0.5;
  }

  focusPoint(kind: string, id: string) {
    if (kind === 'body') {
      const i = this.sim.index(id);
      if (i >= 0) return this.displayPos(i);
    }
    return super.focusPoint(kind, id);
  }

  bodyRadius(id: string) {
    return this.defs.find((d) => d.id === id)?.radius ?? 1;
  }

  info(s: WorldState): InfoCard {
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

const flareCache: Record<string, THREE.Texture> = {};
function flareTexture(kind: 'main' | 'ring') {
  if (flareCache[kind]) return flareCache[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  if (kind === 'main') {
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.1, 'rgba(255,240,220,0.6)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,240,220,0.35)';
    g.fillRect(0, 126, 256, 4);
  } else {
    g.strokeStyle = 'rgba(160,200,255,0.25)';
    g.lineWidth = 10;
    g.beginPath();
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI * 2; g[i ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100); }
    g.stroke();
    g.fillStyle = 'rgba(120,170,255,0.06)';
    g.fill();
  }
  return (flareCache[kind] = new THREE.CanvasTexture(c));
}
