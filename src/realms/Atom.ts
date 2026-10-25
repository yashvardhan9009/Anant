import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Realm, InfoCard, FrameCtx } from '../engine/Realm';
import { makeMotes } from '../engine/fx';
import { OrbitalVolume } from './atomVolume';
import { WaterMolecule, ProtonCore, PROTON_RADIUS_A0, A0_M, niceLength, WATER } from './atomScales';
import { WaterField, PickedAtom } from './waterField';
import { QUALITY } from '../engine/quality';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { WorldState, Env } from '../../shared/worldState';
import { orbitalName } from '../../shared/commands';
import { sampleOrbital, mostProbableRadius, expectedRadius, energyEV, radialProbability, maxRadius, wavelengthToHex } from '../../shared/hydrogen';

const POINTS = QUALITY.atomPoints;
const TARGET_SIZE = 7; // scene units the orbital is fitted to

/** Scene units per Bohr radius for an orbital (so every orbital fits the view; the scale bar shows true size). */
const fitFor = (n: number, l: number) => TARGET_SIZE / (expectedRadius(n, l) * 1.9 + 1);

export class Atom extends Realm {
  readonly id = 'atom' as const;
  private cloud!: THREE.Points;
  private mat!: THREE.ShaderMaterial;
  private geo!: THREE.BufferGeometry;
  private shell!: THREE.Mesh;
  private nucleus!: THREE.Group;
  private photon?: { mesh: THREE.Mesh; trail: THREE.Line; t: number; dir: THREE.Vector3; kind: string; color: THREE.Color };
  private key = '';
  private lastTransition = 0;
  private morph = 1;
  private fitA = 1;
  private fitB = 1;
  private scaleCur = 1;
  private scaleTarget = 1;
  private bg = new THREE.Color('#02040a');
  private scaleLabel!: CSS2DObject;
  private scaleBar!: THREE.Line;
  controlMode = 'orbit' as const;
  current = { n: 1, l: 0, m: 0 };
  private vol = new OrbitalVolume();
  private molecule = new WaterMolecule();
  field = new WaterField();
  /** molecule pinned at the quantum view's position (floating origin follows it) */
  private home = 0;
  private fieldOrigin = new THREE.Vector3();
  private prevL = 0;
  temperature = 300;
  private proton = new ProtonCore();
  /** log10 of physical zoom relative to the 1s framing (powers of ten) */
  zoomL = 0;
  private state0ShowNucleus = true;
  private fieldFog!: THREE.FogExp2;
  /** set by the app when the camera should switch between field (fly) and quantum (orbit) views */
  onViewMode?: (mode: 'field' | 'quantum') => void;
  private camera0Dist(ctx: FrameCtx) { return ctx.camera.position.length(); }
  private layers = { orbital: 1, molecule: 0, liquid: 0, proton: 0 };
  private volFrom: [number, number, number] = [1, 0, 0];
  private volTo: [number, number, number] = [1, 0, 0];
  private volMix = 1;
  private superT = -1;
  /** last transition frequency (Hz), for the info card */
  private transitionHz = 0;

  private studio!: THREE.ShaderMaterial;
  private dust = makeMotes(500, new THREE.Vector3(60, 40, 60), '#7fb8ff', 0.035);
  private envBuilt = false;

  buildEnvironment(pmrem: THREE.PMREMGenerator) {
    if (this.envBuilt) return;
    this.envBuilt = true;
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  }

  protected build() {
    this.look = { exposure: 0.95, bloom: [0.45, 0.5, 0.9], contrast: 1.1, saturation: 1.06, shadows: '#04122a', highlights: '#ffe2c4', vignette: 0.75, godRays: 0 };
    // Studio backdrop: deep navy falling off to steel blue, like a macro product shot
    this.studio = new THREE.ShaderMaterial({
      uniforms: { uTint: { value: new THREE.Color('#3a78c0') }, uTime: { value: 0 } },
      side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 uTint; uniform float uTime; varying vec3 vD;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
        void main(){ vec3 d = normalize(vD);
          float k = smoothstep(-0.6, 1.0, dot(d, normalize(vec3(-0.7, 0.55, 0.45))));
          vec3 col = mix(vec3(0.006,0.016,0.04), uTint, pow(k, 1.15));
          col += vec3(0.05,0.08,0.14) * pow(max(0.0, d.y), 3.0);
          col += (h(floor(d*800.0)) - 0.5) * 0.006;
          gl_FragColor = vec4(col, 1.0); }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), this.studio);
    dome.frustumCulled = false;
    this.scene.add(dome, this.dust);
    const keyL = new THREE.DirectionalLight('#cfe0ff', 1.6);
    keyL.position.set(-6, 8, 6);
    const rimL = new THREE.PointLight('#ff9a50', 30, 30, 2);
    rimL.position.set(4, -2, -5);
    this.scene.add(keyL, rimL, new THREE.AmbientLight('#203050', 0.4));

    this.geo = new THREE.BufferGeometry();
    for (const name of ['position', 'posB']) this.geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(POINTS * 3), 3));
    for (const name of ['signA', 'signB', 'densA', 'densB']) this.geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(POINTS), 1));
    const rnd = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i++) rnd[i] = Math.random();
    this.geo.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uMorph: { value: 1 }, uFitA: { value: 1 }, uFitB: { value: 1 }, uScale: { value: 1 },
        uSlice: { value: 0 }, uPos: { value: new THREE.Color('#ff9a3c') }, uNeg: { value: new THREE.Color('#3fa9ff') }, uPx: { value: window.devicePixelRatio || 1 }, uFocus: { value: 16 },
        uShellR: { value: -1 }, uFlash: { value: 0 }, uFade: { value: 1 },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 posB; attribute float signA, signB, densA, densB, rnd;
        uniform float uTime, uMorph, uFitA, uFitB, uScale, uSlice, uPx, uShellR, uFocus, uFade;
        varying vec3 vCol; varying float vA;
        uniform vec3 uPos, uNeg;
        void main(){
          float k = clamp(uMorph*1.6 - rnd*0.6, 0.0, 1.0);
          k = k*k*(3.0-2.0*k);
          vec3 a = position*uFitA, b = posB*uFitB;
          // swirl during the morph so the electron cloud visibly re-forms
          float sw = sin(k*3.14159)*1.2;
          vec3 p = mix(a, b, k);
          float c = cos(sw*(rnd-0.5)*2.0), s = sin(sw*(rnd-0.5)*2.0);
          p.xz = mat2(c,-s,s,c)*p.xz;
          p *= uScale;
          float sign = mix(signA, signB, step(0.5, k));
          float dens = mix(densA, densB, k);
          vCol = sign > 0.0 ? uPos : uNeg;
          // twinkle: each dot is a possible measurement outcome, flickering in and out
          float tw = 0.45 + 0.55*sin(uTime*(1.5+rnd*4.0) + rnd*80.0);
          vA = (0.25 + 0.75*dens) * tw * 0.4 * uFade; // measurement sparkles sit on top of the volumetric density
          if (uSlice > 0.5 && p.z > 0.0) vA = 0.0;
          if (uShellR > 0.0) { float d = abs(length(p) - uShellR); vA += smoothstep(0.35*uScale, 0.0, d)*0.6; vCol = mix(vCol, vec3(1.0,0.95,0.6), smoothstep(0.35*uScale,0.0,d)); }
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_Position = projectionMatrix*mv;
          // depth of field: dots far from the focal plane grow and dim (macro-lens look)
          float coc = clamp(abs(-mv.z - uFocus) * 0.22, 0.0, 6.0);
          gl_PointSize = clamp((1.6 + dens*2.2) * uPx * 9.0 / -mv.z + coc * uPx * 1.6, 1.0, 22.0);
          vA *= 1.0 / (1.0 + coc*coc*0.35);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vA;
        void main(){ vec2 q = gl_PointCoord-0.5; float a = exp(-dot(q,q)*18.0); if (a*vA < 0.004) discard; gl_FragColor = vec4(vCol*a*vA*1.3, a*vA); }`,
    });
    this.cloud = new THREE.Points(this.geo, this.mat);
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);
    this.scene.add(this.vol.mesh);

    // Nucleus (one proton) — hugely enlarged; the info card states by how much.
    this.nucleus = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 64, 48), new THREE.MeshPhysicalMaterial({ color: '#3d5cff', metalness: 0.55, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.35, envMapIntensity: 2.2 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('#9ab8ff'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
    glow.scale.setScalar(1.1);
    this.nucleus.add(core, glow);
    this.scene.add(this.nucleus, this.molecule.mesh, this.field.group, this.proton.group);
    this.fieldFog = new THREE.FogExp2('#06142a', 0);
    this.scene.fog = this.fieldFog;

    // Most-probable-radius shell
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0-abs(dot(vN,vV)), 3.0); gl_FragColor = vec4(vec3(1.0,0.85,0.55)*f*0.45*(0.8+0.2*sin(uTime*3.0)), f*0.35); }`,
      }),
    );
    this.shell.visible = false;
    this.scene.add(this.shell);

    // Scale bar (1 Å) along the grid
    const barGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]);
    this.scaleBar = new THREE.Line(barGeo, new THREE.LineBasicMaterial({ color: '#7df9ff' }));
    this.scaleBar.position.set(-TARGET_SIZE, -TARGET_SIZE * 0.95, TARGET_SIZE * 0.6);
    const sl = document.createElement('div');
    sl.className = 'label small';
    this.scaleLabel = new CSS2DObject(sl);
    this.scene.add(this.scaleBar, this.scaleLabel);

    this.setOrbital(1, 0, 0, true);
  }

  private setOrbital(n: number, l: number, m: number, instant = false) {
    const s = sampleOrbital(n, l, m, POINTS, 1 + Math.floor(Math.random() * 1000));
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const posB = this.geo.attributes.posB as THREE.BufferAttribute;
    const signA = this.geo.attributes.signA as THREE.BufferAttribute, signB = this.geo.attributes.signB as THREE.BufferAttribute;
    const densA = this.geo.attributes.densA as THREE.BufferAttribute, densB = this.geo.attributes.densB as THREE.BufferAttribute;
    if (instant) {
      (pos.array as Float32Array).set(s.positions);
      (signA.array as Float32Array).set(s.sign);
      (densA.array as Float32Array).set(s.density);
    } else {
      // current B becomes A, then morph to new B
      (pos.array as Float32Array).set(posB.array as Float32Array);
      (signA.array as Float32Array).set(signB.array as Float32Array);
      (densA.array as Float32Array).set(densB.array as Float32Array);
    }
    (posB.array as Float32Array).set(s.positions);
    (signB.array as Float32Array).set(s.sign);
    (densB.array as Float32Array).set(s.density);
    for (const a of [pos, posB, signA, signB, densA, densB]) a.needsUpdate = true;
    this.fitA = instant ? fitFor(n, l) : this.fitB;
    this.fitB = fitFor(n, l);
    this.morph = instant ? 1 : 0;
    this.volFrom = instant ? [n, l, m] : [this.current.n, this.current.l, this.current.m];
    this.volTo = [n, l, m];
    this.volMix = instant ? 1 : 0;
    this.vol.setStates(this.volFrom, this.volTo);
    this.current = { n, l, m };
  }

  protected applyEnv(e: Env) {
    this.studio?.uniforms.uTint.value.set(e.skyColor ?? '#3a78c0');
  }

  sync(state: WorldState, t: number) {
    super.sync(state, t);
    const a = state.atom;
    const key = `${a.n},${a.l},${a.m}`;
    if (key !== this.key) {
      const first = this.key === '';
      // a transition stored in a saved world is history — don't replay its photon on load
      if (first && a.transition) this.lastTransition = a.transition.id;
      this.key = key;
      if (!first || a.n !== 1 || a.l !== 0) this.setOrbital(a.n, a.l, a.m, first);
    }
    if (a.transition && a.transition.id !== this.lastTransition) {
      this.lastTransition = a.transition.id;
      if (a.transition.kind !== 'none') this.firePhoton(a.transition.kind, a.transition.lambda);
    }
    this.scaleTarget = a.scale;
    this.state0ShowNucleus = a.showNucleus;
    this.temperature = a.temperature ?? 300;
    this.mat.uniforms.uSlice.value = a.slice ? 1 : 0;
    this.shell.visible = a.highlight;
  }

  private firePhoton(kind: string, lambda: number) {
    // the electron passes through a superposition of the two states; its density oscillates at ΔE/h
    this.superT = 0;
    this.transitionHz = 299792458 / (lambda * 1e-9);
    if (this.photon) {
      this.scene.remove(this.photon.mesh, this.photon.trail);
    }
    const color = new THREE.Color(wavelengthToHex(lambda));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), new THREE.MeshBasicMaterial({ color }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('#ffffff'), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(1.6);
    mesh.add(glow);
    const trail = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(120 * 3), 3)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    trail.frustumCulled = false;
    const dir = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.4, Math.random() - 0.5).normalize();
    this.photon = { mesh, trail, t: 0, dir, kind, color };
    this.scene.add(mesh, trail);
    this.mat.uniforms.uFlash.value = 1;
    this.sparks.burst(new THREE.Vector3(), color, 200, 5);
  }

  update(ctx: FrameCtx) {
    super.update(ctx);
    const u = this.mat.uniforms;
    u.uTime.value = ctx.t;
    u.uFocus.value = ctx.camera.position.length();
    (this.dust.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.t;
    (this.shell.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.t;
    if (this.morph < 1) this.morph = Math.min(1, this.morph + ctx.rdt / 1.8);
    u.uMorph.value = this.morph;
    // ——— volumetric |ψ|² ———
    const vu = this.vol.mat.uniforms;
    vu.uTime.value = ctx.t;
    vu.uSlice.value = u.uSlice.value;
    if (this.superT >= 0) {
      this.superT += ctx.frozen ? 0 : ctx.rdt;
      const k = Math.min(1, this.superT / 4.5);
      const th = (k * k * (3 - 2 * k)) * Math.PI / 2;
      vu.uSuper.value = 1;
      vu.uA.value = Math.cos(th);
      vu.uB.value = Math.sin(th);
      vu.uPhase.value = this.superT * Math.PI * 2 * 1.4; // ΔE/h slowed ~10¹⁵×
      if (k >= 1) { this.superT = -1; this.volMix = 1; vu.uSuper.value = 0; }
    } else if (this.volMix < 1) {
      this.volMix = Math.min(1, this.volMix + ctx.rdt / 1.8);
    }
    if (this.superT < 0) {
      vu.uMix.value = this.volMix;
      if (this.volMix >= 1 && this.volFrom.join() !== this.volTo.join()) {
        this.volFrom = [...this.volTo];
        this.vol.setStates(this.volFrom, this.volTo);
        vu.uMix.value = 0;
      }
    }
    u.uFitA.value = this.fitA;
    u.uFitB.value = this.fitB;
    // zoom spans ~9 orders of magnitude, so interpolate in log space
    this.scaleCur = Math.exp(Math.log(this.scaleCur) + (Math.log(this.scaleTarget) - Math.log(this.scaleCur)) * Math.min(1, ctx.rdt * 4));
    u.uScale.value = this.scaleCur;
    const fit = this.fitA + (this.fitB - this.fitA) * this.morph;
    const S = fit * this.scaleCur; // scene units per Bohr radius — ONE physical scale for every layer
    this.zoomL = Math.log10(S / fitFor(1, 0));
    const L = this.zoomL;
    const ss = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // real size ratios: H₂O ≈ 2.5× an H atom; a 3 nm droplet ≈ 15×; the proton ≈ 1/60 000
    this.layers = {
      orbital: ss(L, -0.55, -0.15) * (1 - 0.75 * ss(L, 1.8, 3.2)),
      molecule: ss(L, -0.1, -0.5) * (1 - ss(L, -1.0, -1.4)),
      liquid: ss(L, -0.3, -0.75) * (1 - ss(L, -3.6, -4.2)),
      proton: ss(L, 3.9, 4.7),
    };
    this.vol.layout(S, this.volFrom, this.volTo);
    vu.uOpacity.value = this.layers.orbital;
    u.uFade.value = this.layers.orbital * (1 - ss(L, 0.8, 1.6));
    this.cloud.visible = u.uFade.value > 0.01;
    this.molecule.layout(S, this.layers.molecule, ctx.t);
    const projScale = 0;
    // ——— the liquid around you ———
    this.field.temperature = this.temperature;
    if (this.layers.liquid > 0.01 && !ctx.frozen) this.field.step(Math.min(0.05, ctx.dt));
    // floating origin: the home molecule sits exactly where the quantum view is drawn
    this.fieldOrigin.copy(this.field.absPos(this.home)).sub(WATER.O);
    this.field.hidden = this.layers.molecule > 0.5 || this.layers.orbital > 0.5 ? this.home : -1;
    this.field.layout(S, ctx.camera.position, this.fieldOrigin, this.layers.liquid);
    this.fieldFog.density = this.layers.liquid * 0.035 / Math.max(0.2, S / fitFor(1, 0) / (1e-10 / 3e-10));
    if (L < -0.6 && this.prevL >= -0.6) this.onViewMode?.('field');
    if (L > -0.45 && this.prevL <= -0.45) this.onViewMode?.('quantum');
    this.prevL = L;
    void projScale;
    // the proton: drawn at TRUE size when that is visible; otherwise a small marker
    const trueR = PROTON_RADIUS_A0 * S;
    this.proton.layout(trueR, this.layers.proton, ctx.t);
    const shown = Math.max(trueR, 0.035 * Math.max(0.3, Math.min(1, this.camera0Dist(ctx) / 16)));
    this.nucleus.scale.setScalar(shown / 0.14);
    this.nucleus.visible = this.state0ShowNucleus && this.layers.proton < 0.5 && this.layers.orbital > 0.2;
    const rmp = mostProbableRadius(this.current.n, this.current.l) * S;
    this.shell.scale.setScalar(rmp);
    u.uShellR.value = this.shell.visible ? rmp : -1;
    // scale bar: a round physical length (1/2/5 × 10ⁿ m)
    const metersPerUnit = A0_M / S;
    const nice = niceLength(metersPerUnit * 6);
    const len = nice.m / metersPerUnit;
    this.scaleBar.scale.x = len;
    this.scaleLabel.position.copy(this.scaleBar.position).add(new THREE.Vector3(len / 2, 0.4, 0));
    this.scaleLabel.element.textContent = nice.label;
    if (!ctx.frozen) this.cloud.rotation.y += ctx.dt * 0.05;
    // photon flight (real time, so it stays visible even when time is slowed)
    const ph = this.photon;
    if (ph) {
      ph.t += ctx.frozen ? 0 : ctx.rdt;
      const emit = ph.kind === 'emission';
      const d = emit ? ph.t * 9 : Math.max(0, 30 - ph.t * 9);
      const perp = new THREE.Vector3().crossVectors(ph.dir, new THREE.Vector3(0, 1, 0)).normalize();
      const at = (dd: number) => ph.dir.clone().multiplyScalar(dd).add(perp.clone().multiplyScalar(Math.sin(dd * 6) * 0.25));
      ph.mesh.position.copy(at(d));
      const arr = ph.trail.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < 120; i++) {
        const dd = emit ? Math.max(0, d - i * 0.06) : Math.min(30, d + i * 0.06);
        const p = at(dd);
        arr.set([p.x, p.y, p.z], i * 3);
      }
      ph.trail.geometry.attributes.position.needsUpdate = true;
      if (ph.t > 3.4) {
        this.scene.remove(ph.mesh, ph.trail);
        this.photon = undefined;
      }
    }
  }

  inspect(p: PickedAtom) {
    this.home = p.molecule;
  }

  pickables() {
    return [...super.pickables(), ...(this.layers.liquid > 0.3 ? this.field.pickTargets : [])];
  }

  /** Fly speed in the micro-world: your body is always ~3.4 display units tall. */
  flySpeed() {
    return 4;
  }

  info(s: WorldState): InfoCard {
    const L = this.zoomL;
    const fitNow = fitFor(s.atom.n, s.atom.l) * s.atom.scale;
    const view = niceLength((A0_M / fitNow) * 16).label;
    const zoomStat = { label: 'Field of view ≈', value: view };
    if (L < -0.6) return {
      title: 'Inside liquid water · molecular scale',
      mode: 'SCIENTIFIC REALITY',
      subtitle: `You are ${niceLength((A0_M / fitNow) * 6.5).label} tall, swimming through liquid water. Every red–white trio is one H₂O molecule; cyan threads are hydrogen bonds. Fly with WASD/E/Q, click a hydrogen to dive into it.`,
      accuracy: [
        { tag: 'MEASURED', text: 'Density 33.4 molecules/nm³ (≈1 g/cm³), O–H 0.958 Å, ∠HOH 104.45°. Hydrogen bonds use the standard geometric criterion (H···O < 2.5 Å) on the live positions.' },
        { tag: 'SIMULATION', text: `Langevin thermal dynamics at ${this.temperature} K: friction + random kicks, rotational diffusion and short-range O–O repulsion in a periodic box of ${this.field.N} molecules. Time slowed ~10¹³×.` },
        { tag: 'MODEL', text: 'An approximation, not a full molecular-dynamics force field: no electrostatics or polarisation, so the hydrogen-bond network is not reproduced quantitatively.' },
        { tag: 'ARTISTIC', text: 'Ball-and-stick spheres with CPK colours are a convention — atoms have no hard surfaces and no colour at this scale.' },
      ],
      stats: [zoomStat, { label: 'Molecules (periodic)', value: String(this.field.N) }, { label: 'Hydrogen bonds now', value: String(this.field.hbondCount) }, { label: 'Temperature', value: `${this.temperature} K` }],
    };
    if (L < -0.25) return {
      title: 'One water molecule · H₂O',
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'The glow is the electron density of a water molecule: oxygen (cool white) holds most of the electrons; the two hydrogens (amber) share theirs with it. The H at the centre is the atom you started in.',
      accuracy: [
        { tag: 'MEASURED', text: 'Bond length O–H 0.9584 Å and bond angle 104.45° (gas-phase spectroscopy).' },
        { tag: 'MODEL', text: 'Promolecule density: sum of isolated-atom densities (exact H 1s; oxygen from Slater-type orbitals, ζ₁ₛ = 7.70, ζ₂ₛ,₂ₚ = 2.275). Omits the small redistribution caused by bonding.' },
        { tag: 'ARTISTIC', text: 'Brightness curve and colours (which atom the density belongs to) are visual choices.' },
      ],
      stats: [zoomStat, { label: 'Electrons', value: '10 (O: 8, H: 1 each)' }, { label: 'Dipole moment', value: '1.85 D (measured)' }],
    };
    if (L >= 4.2) return {
      title: 'The proton · true size',
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'At last the nucleus at its real size: about 0.84 femtometres across — some 60,000 times smaller than the atom around it.',
      accuracy: [
        { tag: 'MEASURED', text: 'Proton charge radius 0.8414 fm (CODATA). Mass 938.27 MeV/c², only ~1% of which comes from the quarks’ own masses.' },
        { tag: 'ARTISTIC', text: 'The interior is a cartoon of quantum chromodynamics: three valence quarks (u, u, d) shown with their colour charge, gluon flux tubes and a fizz of virtual quark pairs. Quarks do not have definite positions or sizes.' },
      ],
      stats: [zoomStat],
    };
    if (L > 1.6) return {
      title: 'Inside the atom · almost nothing',
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'You are inside the electron cloud, falling toward the nucleus. Nearly all of an atom is empty space: the proton takes up about 10⁻¹⁵ of its volume. Keep scrolling.',
      accuracy: [{ tag: 'MODEL', text: 'The electron cloud is still there, but so diffuse at this magnification that it is almost invisible.' }],
      stats: [zoomStat, { label: 'Proton / atom size', value: '≈ 1 : 60 000' }],
    };
    const { n, l, m } = s.atom;
    const rmp = mostProbableRadius(n, l);
    const fit = fitFor(n, l) * s.atom.scale;
    // proton radius 0.84 fm; a₀ = 52 918 fm
    const protonTrue = PROTON_RADIUS_A0 * fit;
    const exaggeration = Math.max(1, Math.round(0.035 / protonTrue));
    return {
      title: `Hydrogen · ${orbitalName(n, l, m)} orbital`,
      mode: 'SCIENTIFIC REALITY',
      subtitle: 'There is no orbit — only probability. Scroll out to see the molecule this atom belongs to; scroll in to fall toward the nucleus. Press C to fly freely.',
      accuracy: [
        { tag: 'MODEL', text: 'Exact solution of the non-relativistic Schrödinger equation for hydrogen (ignores spin, fine structure, Lamb shift).' },
        { tag: 'SIMULATION', text: `The glow is |ψ_nlm|² integrated along every view ray (volumetric, evaluated exactly per pixel). The sparkles are ${(POINTS / 1000).toFixed(0)}k random position measurements drawn from |ψ|². Colour = sign of the real wavefunction (amber +, blue −).` },
        ...(this.superT >= 0 || this.transitionHz ? [{ tag: 'MODEL' as const, text: `During a transition the electron is in a superposition of both states; its charge density sloshes at ΔE/h ≈ ${(this.transitionHz / 1e15).toFixed(2)} PHz — that oscillating dipole emits the photon. Shown slowed by ~10¹⁵.` }] : []),
        { tag: 'ARTISTIC', text: `Studio lighting, brightness curve, depth-of-field blur, twinkling and the morph between states are visual. At this zoom the proton marker is ~${exaggeration.toLocaleString()}× too large — scroll in (zoom ×10⁵) to see it at true size.` },
      ],
      stats: [
        zoomStat,
        { label: 'Quantum numbers', value: `n=${n}  l=${l}  m=${m}` },
        { label: 'Energy', value: `${energyEV(n).toFixed(3)} eV` },
        { label: 'Most probable r', value: `${rmp.toFixed(2)} a₀ = ${(rmp * 0.0529).toFixed(3)} nm` },
        { label: '⟨r⟩', value: `${expectedRadius(n, l).toFixed(2)} a₀` },
        { label: 'Radial nodes', value: String(n - l - 1) },
        { label: 'Angular nodes', value: String(l) },
      ],
      extraHtml: energyDiagram(n) + radialPlot(n, l, rmp) + (s.atom.transition ? `<div class="photon-note" style="--pc:${wavelengthToHex(s.atom.transition.lambda)}">Last photon: <b>${s.atom.transition.lambda.toFixed(1)} nm</b> (${s.atom.transition.kind}${s.atom.transition.lambda < 380 ? ', ultraviolet — invisible, drawn violet' : s.atom.transition.lambda > 750 ? ', infrared — invisible, drawn red' : ''})</div>` : ''),
    };
  }
}

function energyDiagram(nCur: number) {
  const h = 120, w = 150;
  // E = −13.6 eV at the bottom, 0 eV at the top
  const y = (n: number) => 10 + (-energyEV(n) / 13.6) * (h - 24);
  let s = `<svg class="diagram" viewBox="0 0 ${w} ${h}" aria-label="Energy levels">`;
  for (let n = 1; n <= 4; n++) {
    const yy = y(n);
    s += `<line x1="30" x2="${w - 10}" y1="${yy}" y2="${yy}" stroke="${n === nCur ? '#7df9ff' : '#4a5a7a'}" stroke-width="${n === nCur ? 2.5 : 1}"/>`;
    s += `<text x="4" y="${yy + 3}" fill="#8aa0c0" font-size="8">n=${n}</text><text x="${w - 12}" y="${yy - 3}" fill="#8aa0c0" font-size="7" text-anchor="end">${energyEV(n).toFixed(2)} eV</text>`;
  }
  return s + `<text x="${w / 2}" y="${h - 1}" fill="#5a6a8a" font-size="7" text-anchor="middle">energy levels (to scale)</text></svg>`;
}

function radialPlot(n: number, l: number, rmp: number) {
  const w = 150, h = 60, rMax = Math.min(maxRadius(n), 3 * n * n + 6);
  let max = 0;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 80; i++) {
    const r = (i / 80) * rMax;
    const p = radialProbability(n, l, r);
    max = Math.max(max, p);
    pts.push([r, p]);
  }
  const d = pts.map(([r, p], i) => `${i ? 'L' : 'M'}${((r / rMax) * (w - 10) + 5).toFixed(1)},${(h - 12 - (p / max) * (h - 20)).toFixed(1)}`).join('');
  const xm = (rmp / rMax) * (w - 10) + 5;
  return `<svg class="diagram" viewBox="0 0 ${w} ${h}" aria-label="Radial probability"><path d="${d}" fill="none" stroke="#4fc8ff" stroke-width="1.5"/><line x1="${xm}" x2="${xm}" y1="6" y2="${h - 12}" stroke="#ffe08a" stroke-dasharray="2 2"/><text x="5" y="${h - 2}" fill="#5a6a8a" font-size="7">P(r) = r²|R|²  · 0 → ${rMax.toFixed(0)} a₀</text></svg>`;
}

const texCache = new Map<string, THREE.Texture>();
export function radialTexture(color: string) {
  if (texCache.has(color)) return texCache.get(color)!;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, color);
  grd.addColorStop(0.25, color + 'aa');
  grd.addColorStop(1, '#00000000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  texCache.set(color, t);
  return t;
}
