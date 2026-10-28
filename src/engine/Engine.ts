/**
 * ANANT engine: renderer, post-processing, realms, portals, transitions, picking.
 * The engine renders the world state; it never changes it directly — user
 * intentions are turned into commands by the App and executed by the reducer.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { RealmId } from '../../shared/commands';
import { ARRIVAL, WorldState } from '../../shared/worldState';
import { Realm, FrameCtx } from './Realm';
import { CameraRig } from './CameraRig';
import { PortalView, portalCameraMatrix, PORTAL_RADIUS } from './Portal';
import { Nexus } from '../realms/Nexus';
import { Atom } from '../realms/Atom';
import { Cosmos } from '../realms/Cosmos';
import { Village } from '../realms/Village';
import { HeavyUniverse } from '../realms/HeavyUniverse';
import { QUALITY } from './quality';
import { GradeShader, GodRayShader, Look } from './look';
import { ContactAO } from './ContactAO';

export interface PickResult {
  objectId?: string;
  npcId?: string;
  gate?: RealmId;
  portalId?: string;
  bodyId?: string;
  fieldAtom?: import('../realms/waterField').PickedAtom;
  point?: THREE.Vector3;
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  portalCam: THREE.PerspectiveCamera;
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  warp: ShaderPass;
  godRays: ShaderPass;
  contactAO?: ContactAO;
  pmrem: THREE.PMREMGenerator;
  private adapt = { low: 0, high: 0, ratio: 1 };
  css: CSS2DRenderer;
  rig: CameraRig;
  realms: Record<RealmId, Realm>;
  active: RealmId = 'nexus';
  portals = new Map<string, PortalView>();
  state!: WorldState;
  clock = new THREE.Clock();
  t = 0;
  transitioning = false;
  onPortalCross?: (portalId: string) => void;
  onFrame?: (dt: number) => void;
  fps = { value: 0, frames: 0, acc: 0, frameMs: 0 };
  private raycaster = new THREE.Raycaster();
  private lastFocusSeq = 0;
  private portalFrame = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.adapt.ratio = Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio);
    this.renderer.setPixelRatio(this.adapt.ratio);
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = QUALITY.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.camera = new THREE.PerspectiveCamera(46, host.clientWidth / host.clientHeight, 0.05, 3000);
    this.portalCam = this.camera.clone();
    this.rig = new CameraRig(this.camera);

    this.realms = { nexus: new Nexus(), atom: new Atom(), cosmos: new Cosmos(), village: new Village(), heavy: new HeavyUniverse() };
    this.realms.nexus.ensureBuilt();

    // HDR, multisampled composer: render → god rays → bloom (HDR) → tone map → film grade
    const rt = new THREE.WebGLRenderTarget(host.clientWidth, host.clientHeight, { type: THREE.HalfFloatType, samples: QUALITY.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.adapt.ratio);
    this.renderPass = new RenderPass(this.realms.nexus.scene, this.camera);
    this.godRays = new ShaderPass(GodRayShader);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(host.clientWidth / 2, host.clientHeight / 2), 0.35, 0.45, 0.9);
    this.warp = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    if (QUALITY.ambientOcclusion) {
      this.contactAO = new ContactAO(this.realms.nexus.scene, this.camera);
      this.contactAO.updateGtaoMaterial({ radius: 1.2, thickness: 0.6, distanceFallOff: 1, samples: 8, screenSpaceRadius: false });
      this.contactAO.updatePdMaterial({ radius: 4, samples: 8 });
      this.contactAO.blendIntensity = 0.45;
      this.composer.addPass(this.contactAO);
    }
    if (QUALITY.godRays) this.composer.addPass(this.godRays);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.warp);
    this.warp.uniforms.uResolution.value.set(host.clientWidth * this.adapt.ratio, host.clientHeight * this.adapt.ratio);
    this.applyLook(this.realms.nexus.look);

    this.css = new CSS2DRenderer();
    this.css.setSize(host.clientWidth, host.clientHeight);
    this.css.domElement.className = 'css2d';
    host.appendChild(this.css.domElement);

    window.addEventListener('resize', () => this.resize());
    this.placeCameraOnArrival('nexus');
  }

  applyLook(l: Look) {
    this.renderer.toneMappingExposure = l.exposure;
    [this.bloom.strength, this.bloom.radius, this.bloom.threshold] = l.bloom;
    const u = this.warp.uniforms;
    u.uContrast.value = l.contrast;
    u.uSat.value = l.saturation;
    (u.uShadows.value as THREE.Color).set(l.shadows);
    (u.uHighlights.value as THREE.Color).set(l.highlights);
    u.uVignette.value = l.vignette;
  }

  get realm() {
    return this.realms[this.active];
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.css.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.warp.uniforms.uResolution.value.set(w * pr, h * pr);
    for (const p of this.portals.values()) p.resize(Math.floor(w * pr * QUALITY.portalScale), Math.floor(h * pr * QUALITY.portalScale));
  }

  /** Sync all realms + portals to the authoritative state. */
  sync(state: WorldState) {
    this.state = state;
    for (const r of Object.values(this.realms)) if (r.id === state.activeRealm || state.portals.some((p) => p.to === r.id || p.from === r.id) || (r as any).built) r.sync(state, this.t);
    const ids = new Set(state.portals.map((p) => p.id));
    for (const [id, v] of this.portals) if (!ids.has(id)) {
      v.group.parent?.remove(v.group);
      v.dispose();
      this.portals.delete(id);
    }
    const pr = this.renderer.getPixelRatio();
    for (const p of state.portals) {
      let v = this.portals.get(p.id);
      if (!v) {
        v = new PortalView(p, Math.floor(this.host.clientWidth * pr * QUALITY.portalScale), Math.floor(this.host.clientHeight * pr * QUALITY.portalScale));
        this.portals.set(p.id, v);
        this.realms[p.from].ensureBuilt();
        this.realms[p.from].scene.add(v.group);
        this.realms[p.to].ensureBuilt();
        if (p.from === this.active) this.realm.sparks.burst(new THREE.Vector3(...p.position), '#ffffff', 300, 8);
      } else v.apply(p);
    }
    if (state.focus && state.focus.seq !== this.lastFocusSeq) {
      this.lastFocusSeq = state.focus.seq;
      if (!this.transitioning) this.applyFocus(state.focus.kind, state.focus.id);
    }
  }

  applyFocus(kind: string, id: string) {
    if (kind === 'astro') return; // catalog objects are framed by the realm's scale engine
    const r = this.realm;
    const pt = r.focusPoint(kind, id);
    if (!pt) return;
    if (kind === 'body') {
      const cos = r as Cosmos;
      const rad = cos.bodyRadius(id);
      this.rig.focusOn(pt, Math.max(1.8, rad * 5), () => cos.focusPoint('body', id));
    } else if (kind === 'npc') this.rig.focusOn(pt, 3);
    else {
      const e = r.objects.get(id);
      const size = e ? new THREE.Box3().setFromObject(e.holder, true).getSize(new THREE.Vector3()).length() : 4;
      this.rig.focusOn(pt, Math.max(4, size * 1.3));
    }
  }

  /** Where the camera stands after arriving in a realm (in front of the return portal, facing inward). */
  placeCameraOnArrival(realm: RealmId, viaPortalId?: string, guided = false) {
    const r = this.realms[realm];
    const ret = viaPortalId ? this.state?.portals.find((p) => p.id === this.state.portals.find((q) => q.id === viaPortalId)?.linkedPortalId) : undefined;
    const base = ret ? new THREE.Vector3(...ret.position) : new THREE.Vector3(...ARRIVAL[realm]);
    const yaw = ret?.yaw ?? Math.atan2(-base.x, -base.z);
    const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    if (r.controlMode === 'orbit') {
      const target = new THREE.Vector3();
      const camPos = base.clone().addScaledVector(n, 3.5);
      camPos.y = realm === 'cosmos' || realm === 'heavy' ? 14 : 4;
      this.rig.setOrbit(target, camPos);
      if(!guided){this.rig.update(0,r);this.rig.setFly();}
    } else {
      const position=base.clone().addScaledVector(n,3.5);
      if(guided)this.rig.setWalk(position,Math.atan2(-n.x,-n.z),r.arrivalPitch);
      else this.rig.setFlight(position,Math.atan2(-n.x,-n.z),r.arrivalPitch);
    }
  }

  private hideLabels(scene: THREE.Scene) {
    scene.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.style.display = 'none';
    });
  }

  private animate(dur: number, fn: (k: number) => void): Promise<void> {
    return new Promise((res) => {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / (dur * 1000));
        fn(k);
        if (k < 1) requestAnimationFrame(step);
        else res();
      };
      step();
    });
  }

  /** Cinematic transition to another realm (optionally flying through a portal). */
  async transitionTo(to: RealmId, viaPortalId?: string, color = '#b388ff') {
    if (to === this.active && !viaPortalId) return;
    this.transitioning = true;
    this.rig.locked = true;
    this.realms[to].ensureBuilt();
    (this.warp.uniforms.uColor.value as THREE.Color).set(color);
    const pv = viaPortalId ? this.portals.get(viaPortalId) : undefined;
    const from = this.camera.position.clone();
    const fromRig = this.rig.mode;
    await this.animate(pv ? 0.9 : 0.8, (k) => {
      this.warp.uniforms.uAmt.value = k;
      this.warp.uniforms.uBars.value = Math.min(1, k * 2);
      this.warp.uniforms.uFlash.value = Math.max(0, (k - 0.75) * 4) * 0.9;
      if (pv) {
        // fly into the portal disc
        const target = pv.group.position.clone().addScaledVector(pv.normal, -0.6);
        const e = k * k * (3 - 2 * k);
        if (fromRig !== 'orbit') this.rig.pos.lerpVectors(from, target, e);
        else { this.rig.target.lerp(pv.group.position, e * 0.2); this.rig.radius = THREE.MathUtils.lerp(this.rig.radius, 1.5, e * 0.15); }
      }
    });
    const prev = this.realm;
    prev.onExit();
    this.hideLabels(prev.scene);
    this.active = to;
    this.renderPass.scene = this.realm.scene;
    this.realm.sync(this.state, this.t);
    this.placeCameraOnArrival(to, viaPortalId);
    // reset crossing state so we don't immediately bounce back through the return portal
    for (const p of this.portals.values()) p.prevSide = 1;
    this.realm.onEnter(this.state);
    this.realm.buildEnvironment(this.pmrem);
    this.applyLook(this.realm.look);
    this.rig.locked = false;
    await this.animate(1.2, (k) => {
      this.warp.uniforms.uAmt.value = 1 - k;
      this.warp.uniforms.uBars.value = Math.max(0, 1 - k * 1.4);
      this.warp.uniforms.uFlash.value = Math.max(0, 0.9 - k * 2.2);
    });
    this.warp.uniforms.uAmt.value = 0;
    this.warp.uniforms.uFlash.value = 0;
    this.warp.uniforms.uBars.value = 0;
    this.transitioning = false;
  }

  /** Raycast from normalized device coords. */
  pick(ndc: THREE.Vector2): PickResult {
    this.raycaster.setFromCamera(ndc, this.camera);
    const r = this.realm;
    const targets: THREE.Object3D[] = [...r.pickables()];
    for (const p of this.portals.values()) if (p.state.from === this.active) targets.push(p.disc);
    if (r instanceof Nexus) targets.push(...r.gates);
    if (r instanceof Cosmos) r.scene.traverse((o) => o.userData.bodyId && targets.push(o));
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.object.userData.waterField && r instanceof Atom) {
        const a = r.field.pick(h);
        if (a) return { fieldAtom: a, point: h.point };
        continue;
      }
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const u = o.userData;
        if (u.portalId) return { portalId: u.portalId, point: h.point };
        if (u.objectId) return { objectId: u.objectId, point: h.point };
        if (u.npcId) return { npcId: u.npcId, point: h.point };
        if (u.gate) return { gate: u.gate, point: h.point };
        if (u.bodyId) return { bodyId: u.bodyId, point: h.point };
        o = o.parent;
      }
    }
    return {};
  }

  /** Ray from NDC intersected with a horizontal plane at height y. */
  rayToPlane(ndc: THREE.Vector2, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out) ? out : null;
  }

  /** Point on a camera-facing plane through `through`. */
  rayToFacingPlane(ndc: THREE.Vector2, through: THREE.Vector3): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = this.rig.forward.negate();
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, through), out) ? out : null;
  }

  private renderPortals() {
    // Cache previews in the lightweight tier. Crossing still updates every frame.
    if (QUALITY.low && this.portalFrame++ % 3 !== 0) return;
    const exitMat = new THREE.Matrix4();
    for (const pv of this.portals.values()) {
      if (pv.state.from !== this.active) continue;
      const dist = pv.group.position.distanceTo(this.camera.position);
      // only render portals that are reasonably near and in front of the camera
      const toPortal = pv.group.position.clone().sub(this.camera.position);
      const inView = toPortal.dot(this.rig.forward) > -PORTAL_RADIUS && dist < 120;
      pv.group.visible = true;
      if (!inView) continue;
      const dest = this.realms[pv.state.to];
      dest.buildEnvironment(this.pmrem);
      const exit = this.state.portals.find((p) => p.id === pv.state.linkedPortalId);
      const exitPos = new THREE.Vector3(...(exit?.position ?? ARRIVAL[pv.state.to]));
      const exitYaw = exit?.yaw ?? Math.atan2(-exitPos.x, -exitPos.z);
      if (dest.controlMode === 'orbit') {
        // orbit realms: frame the scene centre from the arrival side
        exitPos.y = Math.max(exitPos.y, pv.state.to === 'cosmos' || pv.state.to === 'heavy' ? 10 : 3);
      }
      exitMat.compose(exitPos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, exitYaw, 0)), new THREE.Vector3(1, 1, 1));
      pv.group.updateMatrixWorld();
      portalCameraMatrix(this.camera, pv.group.matrixWorld, exitMat, this.portalCam.matrixWorld);
      this.portalCam.matrixWorld.decompose(this.portalCam.position, this.portalCam.quaternion, this.portalCam.scale);
      this.portalCam.fov = this.camera.fov;
      this.portalCam.aspect = this.camera.aspect;
      this.portalCam.near = Math.max(0.05, dist * 0.5);
      this.portalCam.updateProjectionMatrix();
      this.portalCam.updateMatrixWorld(true);
      // hide the destination's own portals (we look out through one of them)
      const hidden: PortalView[] = [];
      for (const q of this.portals.values()) if (q.state.from === pv.state.to && q.group.visible) { q.group.visible = false; hidden.push(q); }
      this.renderer.setRenderTarget(pv.rt);
      const updateShadows=this.renderer.shadowMap.autoUpdate;
      let missingShadow=false;
      dest.scene.traverse(object=>{const light=object as THREE.Light & {shadow?:THREE.LightShadow};if(light.isLight&&light.castShadow&&!light.shadow?.map)missingShadow=true;});
      this.renderer.shadowMap.autoUpdate=missingShadow;
      try { this.renderer.render(dest.scene, this.portalCam); }
      finally { this.renderer.shadowMap.autoUpdate=updateShadows; }
      this.renderer.setRenderTarget(null);
      hidden.forEach((q) => (q.group.visible = true));
    }
  }

  private checkPortalCrossing() {
    if (this.transitioning) return;
    for (const pv of this.portals.values()) {
      if (pv.state.from !== this.active || pv.open < 0.9) continue;
      const rel = this.camera.position.clone().sub(pv.group.position);
      const side = rel.dot(pv.normal);
      const lateral = rel.clone().addScaledVector(pv.normal, -side).length();
      if (pv.prevSide > 0 && side <= 0 && lateral < PORTAL_RADIUS * 1.1 && Math.abs(side) < 1.5) {
        pv.prevSide = side;
        this.onPortalCross?.(pv.state.id);
        return;
      }
      pv.prevSide = side;
    }
  }

  suspended = false;

  frame() {
    const t0 = performance.now();
    const wallDt = this.clock.getDelta();
    if (this.suspended) return;
    const rdt = Math.min(0.05, wallDt);
    const st = this.state;
    const frozen = st?.time.frozen ?? false;
    const dt = frozen ? 0 : rdt * (st?.time.scale ?? 1);
    this.t += frozen ? 0 : rdt * (st?.time.scale ?? 1);
    this.rig.update(Math.min(.1, wallDt), this.realm);
    if (st) {
      const ctx: FrameCtx = { camera: this.camera, state: st, dt, rdt, t: this.t, frozen, active: true };
      this.realm.update(ctx);
      // destination realms visible through portals keep living
      const visibleDest = new Set([...this.portals.values()].filter((p) => p.state.from === this.active).map((p) => p.state.to));
      for (const id of visibleDest) this.realms[id].update({ ...ctx, camera: this.portalCam, active: false });
      for (const p of this.portals.values()) if (p.state.from === this.active) p.update(this.t, rdt);
      this.rig.trackFollow();
      this.checkPortalCrossing();
      this.renderPortals();
    }
    this.warp.uniforms.uTime.value = this.t;
    this.realm.buildEnvironment(this.pmrem);
    if (!this.transitioning) this.applyLook(this.realm.look);
    this.updateGodRays();
    if (this.contactAO) {
      this.contactAO.scene = this.realm.scene;
      this.contactAO.enabled = this.active === 'nexus' || this.active === 'village';
    }
    this.composer.render();
    this.css.render(this.realm.scene, this.camera);
    this.onFrame?.(rdt);
    // honest FPS: frames actually presented per wall-clock second
    this.fps.frames++;
    this.fps.acc += wallDt;
    this.fps.frameMs = this.fps.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.fps.acc >= 1) {
      this.fps.value = this.fps.frames / this.fps.acc;
      this.fps.frames = 0;
      this.fps.acc = 0;
      this.adaptResolution();
    }
  }

  private updateGodRays() {
    const r = this.realm;
    const u = this.godRays.uniforms;
    if (!r.sunWorld || !r.look.godRays) { u.uStrength.value = 0; return; }
    const p = r.sunWorld.clone().project(this.camera);
    const facing = r.sunWorld.clone().sub(this.camera.position).dot(this.rig.forward) > 0;
    const sx = p.x * 0.5 + 0.5, sy = p.y * 0.5 + 0.5;
    const off = Math.max(0, Math.max(Math.abs(p.x), Math.abs(p.y)) - 1);
    (u.uSun.value as THREE.Vector2).set(sx, sy);
    u.uStrength.value = facing ? r.look.godRays * Math.max(0, 1 - off * 1.5) : 0;
  }

  /** Keep interaction smooth: lower internal resolution if FPS drops, raise it when there is headroom. */
  private adaptResolution() {
    if (!QUALITY.adaptive || this.transitioning) return;
    const f = this.fps.value, a = this.adapt;
    const max = Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio);
    if (f < QUALITY.targetFps - 3) { a.low++; a.high = 0; } else if (f > QUALITY.targetFps + 10) { a.high++; a.low = 0; } else { a.low = a.high = 0; }
    let next = a.ratio;
    const min = Math.min(max, QUALITY.minPixelRatio);
    if (a.low >= 3 && a.ratio > min) next = Math.max(min, a.ratio - 0.1);
    if (a.high >= 5 && a.ratio < max) next = Math.min(max, a.ratio + 0.1);
    if (next !== a.ratio) {
      a.ratio = next; a.low = a.high = 0;
      this.renderer.setPixelRatio(next);
      this.composer.setPixelRatio(next);
      this.resize();
    }
  }

  get pixelRatio() { return this.adapt.ratio; }

  start() {
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
