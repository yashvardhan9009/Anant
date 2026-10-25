import * as THREE from 'three';
import type { RealmId } from '../../shared/commands';
import type { WorldState, Env } from '../../shared/worldState';
import { ObjectLayer } from './ObjectLayer';
import { Sparks } from './fx';
import { Look, DEFAULT_LOOK } from './look';

export type AccuracyTag = 'MEASURED' | 'MODEL' | 'SIMULATION' | 'ARTISTIC' | 'FICTION' | 'HYPOTHETICAL';

export interface InfoCard {
  title: string;
  mode: 'SCIENTIFIC REALITY' | 'IMAGINATIVE REALITY' | 'THE THRESHOLD' | 'HYPOTHETICAL UNIVERSE';
  subtitle: string;
  accuracy: { tag: AccuracyTag; text: string }[];
  stats: { label: string; value: string }[];
  /** optional extra HTML (energy diagram, clue list) — built from trusted engine data only */
  extraHtml?: string;
}

export interface FrameCtx {
  camera: THREE.PerspectiveCamera;
  state: WorldState;
  /** scaled by global time scale; 0 when frozen */
  dt: number;
  /** real seconds (for UI-ish animation) */
  rdt: number;
  t: number;
  frozen: boolean;
  active: boolean;
}

export abstract class Realm {
  abstract readonly id: RealmId;
  scene = new THREE.Scene();
  objects: ObjectLayer;
  sparks = new Sparks();
  controlMode: 'orbit' | 'walk' = 'walk';
  /** orbit-mode pivot */
  orbitTarget = new THREE.Vector3();
  /** soft bounds for the camera in walk mode */
  bounds = 60;
  eyeHeight = 2.2;
  /** camera pitch when arriving (radians, + looks up) */
  arrivalPitch = -0.05;
  /** cinematic grade for this realm */
  look: Look = { ...DEFAULT_LOOK };
  /** world-space sun position for god rays (if any) */
  sunWorld?: THREE.Vector3;
  /** object rendered into the environment map (sky) — reflections come from it */
  envSource?: THREE.Object3D;
  /** an equirectangular HDRI to light the realm with (takes precedence over envSource) */
  envTexture?: THREE.Texture;
  envDirty = true;
  private envRT?: THREE.WebGLRenderTarget;
  protected built = false;
  protected env?: Env;

  constructor() {
    this.objects = new ObjectLayer((x, z) => this.groundY(x, z));
    this.objects.onSpawnFx = (p, c) => this.sparks.burst(p.clone().add(new THREE.Vector3(0, 1, 0)), c, 220, 7);
    this.scene.add(this.objects.group, this.sparks.points);
  }

  ensureBuilt() {
    if (!this.built) {
      this.build();
      this.built = true;
    }
  }

  protected abstract build(): void;

  groundY(_x: number, _z: number): number {
    return 0;
  }

  sync(state: WorldState, t: number) {
    this.ensureBuilt();
    this.objects.sync(state.objects.filter((o) => o.realm === this.id), state.activeRealm === this.id ? state.selectedId : undefined, t);
    const e = state.env[this.id];
    if (e !== this.env) {
      this.applyEnv(e, this.env);
      this.env = e;
    }
  }

  protected applyEnv(_e: Env, _prev?: Env) {}

  /** (Re)build image-based lighting from the realm's sky so metals and wet surfaces reflect it. */
  buildEnvironment(pmrem: THREE.PMREMGenerator) {
    if ((!this.envSource && !this.envTexture) || !this.envDirty) return;
    this.envDirty = false;
    if (this.envTexture) {
      this.envRT?.dispose();
      this.envRT = pmrem.fromEquirectangular(this.envTexture);
      this.scene.environment = this.envRT.texture;
      return;
    }
    const tmp = new THREE.Scene();
    const clone = this.envSource!.clone();
    clone.scale.setScalar(0.1);
    tmp.add(clone);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(tmp, 0.02);
    this.scene.environment = this.envRT.texture;
  }

  update(ctx: FrameCtx) {
    this.objects.update(ctx.t, ctx.dt, this.env?.gravity ?? 1, ctx.frozen);
    if (!ctx.frozen) this.sparks.update(ctx.rdt);
  }

  abstract info(state: WorldState): InfoCard;

  /** World position of a focus target in this realm. */
  focusPoint(kind: string, id: string): THREE.Vector3 | undefined {
    if (kind === 'object') {
      const e = this.objects.get(id);
      if (e) return new THREE.Box3().setFromObject(e.holder).getCenter(new THREE.Vector3());
    }
    return undefined;
  }

  pickables(): THREE.Object3D[] {
    return this.objects.pickables();
  }

  /**
   * Map the observer's apparent size (metres) onto this realm's camera.
   * Default (human-scale realms): eye height and walking speed follow body size.
   */
  applyObserver(size: number, rig: import('./CameraRig').CameraRig) {
    this.eyeHeight = Math.min(900, Math.max(0.25, size * 0.93));
    rig.speedScale = Math.min(400, Math.max(0.2, size / 1.7));
  }

  /** Called when the user enters the realm. */
  onEnter(_state: WorldState) {}
  onExit() {}
}
