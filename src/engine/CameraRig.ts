/** First-person walking + orbit camera, with smooth focus/fly-to. Input-agnostic: callers feed it deltas. */
import * as THREE from 'three';
import type { Realm } from './Realm';
import { dampedMotion } from './motion';

export class CameraRig {
  yaw = 0;
  pitch = -0.05;
  pos = new THREE.Vector3(0, 2.2, 14);
  // orbit
  target = new THREE.Vector3();
  radius = 16;
  theta = 0; // around Y
  phi = 1.2; // from +Y
  mode: 'walk' | 'orbit' | 'fly' = 'walk';
  /** seconds since the last user input (drives the cinematic idle drift) */
  idle = 0;
  keys = new Set<string>();
  private fly?: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; t: number; dur: number; fromYaw: number; fromPitch: number };
  follow?: () => THREE.Vector3 | undefined;
  followRadius?: number;
  locked = false;
  /** movement speed multiplier from the observer's apparent size */
  speedScale = 1;
  onStep?: (running: boolean) => void;
  private velocity = new THREE.Vector3();
  private stepDistance = 0;
  private gait = 0;
  private reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(public camera: THREE.PerspectiveCamera) {}

  setWalk(pos: THREE.Vector3, yaw: number, pitch = -0.05) {
    this.mode = 'walk';
    this.pos.copy(pos);
    this.yaw = yaw;
    this.pitch = pitch;
    this.follow = undefined;
    this.fly = undefined;
    this.stopMotion();
  }

  stopMotion() { this.keys.clear(); this.velocity.set(0, 0, 0); this.stepDistance = 0; }

  setFlight(pos: THREE.Vector3, yaw: number, pitch = -.05) {
    this.setWalk(pos, yaw, pitch);
    this.mode = 'fly';
    this.camera.position.copy(pos);
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  /** Free 6-DOF POV: look anywhere, fly anywhere — above, below, inside. */
  setFly() {
    this.stopMotion();
    const f = this.forward;
    this.pos.copy(this.camera.position);
    this.yaw = Math.atan2(-f.x, -f.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    this.mode = 'fly';
    this.follow = undefined;
    this.fly = undefined;
  }

  setOrbit(target: THREE.Vector3, camPos: THREE.Vector3) {
    this.stopMotion();
    this.mode = 'orbit';
    this.target.copy(target);
    const d = camPos.clone().sub(target);
    this.radius = d.length();
    this.theta = Math.atan2(d.x, d.z);
    this.phi = Math.acos(THREE.MathUtils.clamp(d.y / this.radius, -1, 1));
    this.follow = undefined;
    this.fly = undefined;
  }

  get forward() {
    const v = new THREE.Vector3();
    this.camera.getWorldDirection(v);
    return v;
  }

  /** Camera yaw in the convention used by portals (normal = (sin yaw, 0, cos yaw) faces the camera). */
  get facingYaw() {
    const f = this.forward;
    return Math.atan2(-f.x, -f.z);
  }

  inFront(dist = 7): THREE.Vector3 {
    return this.camera.position.clone().add(this.forward.setY(0).normalize().multiplyScalar(dist));
  }

  rotate(dx: number, dy: number) {
    if (this.locked) return;
    this.fly = undefined;
    this.idle = 0;
    if (this.mode === 'walk' || this.mode === 'fly') {
      this.yaw -= dx * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.004, -1.55, 1.55);
    } else {
      this.theta -= dx * 0.005;
      this.phi = THREE.MathUtils.clamp(this.phi - dy * 0.005, 0.01, Math.PI - 0.01);
    }
  }

  zoom(delta: number) {
    if (this.locked) return;
    this.idle = 0;
    if (this.mode === 'fly') {
      this.pos.addScaledVector(this.forward, -delta * 0.002 * this.flySpeed());
      return;
    }
    if (this.mode === 'orbit') {
      this.radius = THREE.MathUtils.clamp(this.radius * Math.pow(1.0015, delta), 0.15, 400);
      if (this.followRadius) this.followRadius = this.radius;
    } else {
      const f = this.forward.setY(0).normalize();
      this.pos.addScaledVector(f, -delta * 0.01);
    }
  }

  /** Fly speed scales with distance from the scene centre so close-up inspection stays controllable. */
  flySpeed() {
    return THREE.MathUtils.clamp(this.pos.length() * 0.5, 0.4, 80) * Math.min(50, Math.max(0.02, this.speedScale));
  }

  /** Keep depth precision when the camera gets very close to things. */
  private adaptNear() {
    const d = this.mode === 'orbit' ? this.radius : this.pos.length();
    const near = THREE.MathUtils.clamp(d * 0.004, 0.002, 0.08);
    if (Math.abs(near - this.camera.near) > 1e-4) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Smoothly move to look at a point. */
  focusOn(point: THREE.Vector3, distance: number, follow?: () => THREE.Vector3 | undefined) {
    if (this.mode === 'orbit') {
      this.follow = follow;
      this.followRadius = distance;
      this.fly = { from: this.target.clone(), to: point.clone(), look: point.clone(), t: 0, dur: 1.4, fromYaw: this.radius, fromPitch: 0 };
    } else {
      const dir = point.clone().sub(this.pos).setY(0);
      const d = dir.length();
      const stop = this.pos.clone().add(dir.normalize().multiplyScalar(Math.max(0, d - distance)));
      this.fly = { from: this.pos.clone(), to: stop, look: point.clone(), t: 0, dur: 1.4, fromYaw: this.yaw, fromPitch: this.pitch };
    }
  }

  update(dt: number, realm: Pick<Realm, 'bounds' | 'groundY' | 'eyeHeight' | 'constrainWalk' | 'controlMode'>) {
    const fov = this.mode === 'walk' ? 58 : this.mode === 'fly' ? 60 : 46;
    if (Math.abs(this.camera.fov - fov) > .01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-5 * dt)); this.camera.updateProjectionMatrix();
    }
    const speed = (this.keys.has('shift') ? 16 : 7) * dt * (this.mode === 'walk' ? this.speedScale : 1);
    const move = new THREE.Vector3();
    if (!this.locked) {
      if (this.keys.has('w') || this.keys.has('arrowup')) move.z -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) move.z += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) move.x -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) move.x += 1;
    }
    if (move.lengthSq() || this.keys.has('e') || this.keys.has('q')) this.idle = 0;
    else this.idle += dt;
    if (this.mode === 'fly') {
      const sp = ((realm as any).flySpeed?.() ?? this.flySpeed()) * (this.keys.has('shift') ? 4 : 1);
      const fwd = this.forward;
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const moving=move.lengthSq()||this.keys.has('e')||this.keys.has('q');
      if(moving)this.fly=undefined;
      if(this.fly&&!this.locked){
        const a=Math.min(1,(this.fly.t+=dt)/this.fly.dur),k=a*a*(3-2*a);
        this.pos.lerpVectors(this.fly.from,this.fly.to,k);
        const look=this.fly.look.clone().sub(this.pos),yaw=Math.atan2(-look.x,-look.z),pitch=Math.atan2(look.y,Math.hypot(look.x,look.z));
        const delta=Math.atan2(Math.sin(yaw-this.fly.fromYaw),Math.cos(yaw-this.fly.fromYaw));
        this.yaw=this.fly.fromYaw+delta*k;this.pitch=THREE.MathUtils.lerp(this.fly.fromPitch,pitch,k);
        this.velocity.set(0,0,0);if(a===1)this.fly=undefined;
      } else if (!this.locked) {
        const desired=fwd.multiplyScalar(-move.z).addScaledVector(right,move.x);
        desired.y+=(this.keys.has('e')?1:0)-(this.keys.has('q')?1:0);
        if(desired.lengthSq()>1)desired.normalize();desired.multiplyScalar(sp);
        for(const axis of ['x','y','z'] as const){const motion=dampedMotion(this.velocity[axis],desired[axis],moving?4:7,dt);this.velocity[axis]=motion.velocity;this.pos[axis]+=motion.distance;}
      }
      // never fall through the ground in walkable realms
      const gy = realm.controlMode === 'walk' ? realm.groundY(this.pos.x, this.pos.z) + 0.3 : -Infinity;
      if (this.pos.y < gy) this.pos.y = gy;
      this.camera.position.copy(this.pos);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      this.adaptNear();
      this.camera.updateMatrixWorld();
      return;
    }
    const e = this.fly ? Math.min(1, (this.fly.t += dt) / this.fly.dur) : 0;
    const ease = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2;
    if (this.mode === 'walk') {
      const walking = move.lengthSq() > 0;
      const before = this.pos.clone();
      if (walking) this.fly = undefined;
      if (this.locked || this.fly) this.velocity.set(0, 0, 0);
      const desired = move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw)
        .multiplyScalar((this.keys.has('shift') ? 4.8 : 1.75) * this.speedScale);
      const x = dampedMotion(this.velocity.x, desired.x, 12, dt), z = dampedMotion(this.velocity.z, desired.z, 12, dt);
      this.velocity.set(x.velocity, 0, z.velocity);
      // Small collision steps prevent fast or giant observers tunnelling through houses.
      const count = Math.min(128, Math.max(1, Math.ceil(Math.hypot(x.distance,z.distance) / .18)));
      for (let i = 0; i < count; i++) {
        this.pos.x += x.distance / count; this.pos.z += z.distance / count;
        realm.constrainWalk?.(this.pos);
      }
      if (this.fly) {
        this.pos.lerpVectors(this.fly.from, this.fly.to, ease);
        const look = this.fly.look.clone().sub(this.pos);
        const ty = Math.atan2(-look.x, -look.z);
        const tp = Math.atan2(look.y, Math.hypot(look.x, look.z));
        let dy = ty - this.fly.fromYaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        this.yaw = this.fly.fromYaw + dy * ease;
        this.pitch = this.fly.fromPitch + (THREE.MathUtils.clamp(tp, -1.2, 1.2) - this.fly.fromPitch) * ease;
        if (e >= 1) this.fly = undefined;
      }
      realm.constrainWalk?.(this.pos);
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > realm.bounds) this.pos.multiplyScalar(realm.bounds / r).setY(this.pos.y);
      const gy = realm.groundY(this.pos.x, this.pos.z) + realm.eyeHeight;
      this.pos.y += (gy - this.pos.y) * Math.min(1, dt * 10);
      const travelled = walking ? Math.hypot(this.pos.x-before.x,this.pos.z-before.z) : 0;
      this.stepDistance += travelled;
      if (this.stepDistance > .86 * this.speedScale) { this.stepDistance %= .86 * this.speedScale; this.onStep?.(this.keys.has('shift')); }
      this.gait += travelled / Math.max(.1,this.speedScale) * 7.3;
      this.camera.position.copy(this.pos);
      if (!this.reducedMotion && walking) this.camera.position.y += Math.sin(this.gait) * .012 * Math.min(2,this.speedScale);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    } else {
      if (move.lengthSq()) {
        this.fly = undefined;
        this.follow = undefined;
        const right = new THREE.Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
        const fwd = new THREE.Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta));
        this.target.addScaledVector(right, move.x * speed * this.radius * 0.12).addScaledVector(fwd, -move.z * speed * this.radius * 0.12);
      }
      if (this.fly) {
        const to = this.follow?.() ?? this.fly.to;
        this.target.lerpVectors(this.fly.from, to, ease);
        if (this.followRadius) this.radius += (this.followRadius - this.radius) * Math.min(1, dt * 3);
        if (e >= 1) this.fly = undefined;
      } else if (this.follow) {
        const p = this.follow();
        if (p) this.target.copy(p);
        if (this.followRadius) this.radius += (this.followRadius - this.radius) * Math.min(1, dt * 3);
      }
      const s = Math.sin(this.phi);
      // cinematic drift: after a few seconds without input the camera slowly circles the subject
      if (this.idle > 6 && !this.locked) {
        const k = Math.min(1, (this.idle - 6) / 4);
        this.theta += dt * 0.045 * k;
        this.phi += Math.sin(this.idle * 0.12) * dt * 0.01 * k;
      }
      this.camera.position.set(this.target.x + this.radius * s * Math.sin(this.theta), this.target.y + this.radius * Math.cos(this.phi), this.target.z + this.radius * s * Math.cos(this.theta));
      this.camera.lookAt(this.target);
      this.adaptNear();
    }
    this.camera.updateMatrixWorld();
  }

  /** Follow the subject's freshly simulated position without a frame of orbital lag. */
  trackFollow() {
    if (this.mode !== 'orbit' || this.fly || !this.follow) return;
    const p = this.follow();
    if (!p) return;
    this.camera.position.add(p.clone().sub(this.target));
    this.target.copy(p);
    this.camera.updateMatrixWorld();
  }
}
