/**
 * Keeps Three.js meshes in sync with the authoritative SceneObject list, and runs
 * a light point-mass physics model (gravity, ground contact, push impulses) for
 * objects that are not floating. When a physically moving object comes to rest,
 * the layer reports its final position so the app can commit it to world state.
 */
import * as THREE from 'three';
import type { SceneObject } from '../../shared/worldState';
import { buildObject, Built } from './objects';

interface Entry {
  obj: SceneObject;
  built: Built;
  holder: THREE.Group; // positioned by state/physics
  vel: THREE.Vector3;
  moving: boolean;
  spawnT: number;
  bobPhase: number;
  colorKey: string;
}

export class ObjectLayer {
  group = new THREE.Group();
  entries = new Map<string, Entry>();
  selectedId?: string;
  private ring: THREE.Mesh;
  /** object id currently being dragged by the user (physics paused for it) */
  grabbedId?: string;
  onRest?: (id: string, pos: [number, number, number]) => void;
  onSpawnFx?: (pos: THREE.Vector3, color: string) => void;

  constructor(private groundY: (x: number, z: number) => number = () => 0) {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.12, 64),
      new THREE.MeshBasicMaterial({ color: '#7df9ff', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  sync(objects: SceneObject[], selectedId: string | undefined, t: number) {
    const seen = new Set<string>();
    for (const o of objects) {
      seen.add(o.id);
      let e = this.entries.get(o.id);
      const colorKey = `${o.kind}|${o.color}|${o.glow}`;
      if (e && e.colorKey !== colorKey) {
        this.remove(o.id);
        e = undefined;
      }
      if (!e) {
        const built = buildObject(o.kind, o.color);
        const holder = new THREE.Group();
        holder.add(built.root);
        holder.userData.objectId = o.id;
        built.root.traverse((c) => (c.userData.objectId = o.id));
        if (o.glow) for (const m of built.tint) { m.emissive = new THREE.Color(o.color); m.emissiveIntensity = Math.max(m.emissiveIntensity, 1.2); }
        this.group.add(holder);
        e = { obj: o, built, holder, vel: new THREE.Vector3(), moving: false, spawnT: t, bobPhase: Math.random() * 6.28, colorKey };
        holder.position.set(...o.position);
        this.entries.set(o.id, e);
        this.onSpawnFx?.(holder.position.clone(), o.color);
        // Non-floating objects spawned in the air fall under gravity.
        if (!o.floating && o.position[1] > this.groundY(o.position[0], o.position[2]) + 0.05) e.moving = true;
      } else if (!e.moving && e.obj !== o && this.grabbedId !== o.id) {
        // state changed (command or commit) → snap to authoritative position
        const p = o.position;
        if (e.holder.position.distanceToSquared(new THREE.Vector3(...p)) > 1e-6) {
          e.holder.position.set(...p);
          if (!o.floating && p[1] > this.groundY(p[0], p[2]) + 0.05) e.moving = true;
        }
      }
      e.obj = o;
      e.holder.rotation.set(...o.rotation);
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.remove(id);
    this.selectedId = selectedId;
  }

  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.group.remove(e.holder);
    e.holder.traverse((c: any) => {
      c.geometry?.dispose?.();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: any) => m.dispose());
    });
    this.entries.delete(id);
  }

  pickables(): THREE.Object3D[] {
    return [...this.entries.values()].map((e) => e.holder);
  }

  get(id: string) {
    return this.entries.get(id);
  }

  /** Apply an impulse (units/s) to every non-floating object within radius of a point. */
  push(origin: THREE.Vector3, dir: THREE.Vector3, strength: number, radius = 14): string[] {
    const hit: string[] = [];
    for (const [id, e] of this.entries) {
      const d = e.holder.position.distanceTo(origin);
      if (d > radius) continue;
      const k = strength * (1 - d / radius);
      e.vel.addScaledVector(dir, k).add(new THREE.Vector3(0, k * 0.5, 0));
      e.moving = true;
      hit.push(id);
    }
    return hit;
  }

  update(t: number, dt: number, gravity: number, frozen: boolean) {
    for (const [id, e] of this.entries) {
      const age = t - e.spawnT;
      // materialise: elastic scale-in
      const k = Math.min(1, age / 0.9);
      const ease = k === 1 ? 1 : 1 - Math.pow(2, -10 * k) * Math.cos(k * 10);
      const s = e.obj.scale * ease;
      e.built.root.scale.setScalar(Math.max(0.001, s));
      if (frozen) continue;
      e.built.animate?.(t, dt);
      if (id === this.grabbedId) continue;
      if (e.obj.floating) {
        e.built.root.position.y = Math.sin(t * 0.8 + e.bobPhase) * 0.25 * Math.min(2, e.obj.scale);
        if (e.moving) {
          // floating objects drift and slow down (no gravity)
          e.holder.position.addScaledVector(e.vel, dt);
          e.vel.multiplyScalar(Math.pow(0.4, dt));
          if (e.vel.lengthSq() < 0.01) this.settle(id, e);
        }
        continue;
      }
      if (!e.moving) continue;
      e.vel.y -= 9.8 * gravity * dt;
      e.holder.position.addScaledVector(e.vel, dt);
      const gy = this.groundY(e.holder.position.x, e.holder.position.z) - e.built.base * e.obj.scale;
      if (e.holder.position.y <= gy) {
        e.holder.position.y = gy;
        if (Math.abs(e.vel.y) > 1.5) e.vel.y = -e.vel.y * 0.35;
        else e.vel.y = 0;
        e.vel.x *= Math.pow(0.05, dt);
        e.vel.z *= Math.pow(0.05, dt);
      }
      if (gravity === 0) e.vel.multiplyScalar(Math.pow(0.7, dt));
      if (e.vel.lengthSq() < 0.004 && (e.holder.position.y <= gy + 0.01 || gravity === 0)) this.settle(id, e);
    }
    const sel = this.selectedId ? this.entries.get(this.selectedId) : undefined;
    this.ring.visible = !!sel;
    if (sel) {
      const box = new THREE.Box3().setFromObject(sel.built.root);
      const size = box.getSize(new THREE.Vector3());
      const r = Math.max(size.x, size.z) * 0.6 + 0.3;
      this.ring.scale.setScalar(r);
      this.ring.position.set(sel.holder.position.x, box.min.y + 0.05, sel.holder.position.z);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 4) * 0.3;
    }
  }

  private settle(id: string, e: Entry) {
    e.moving = false;
    e.vel.set(0, 0, 0);
    const p = e.holder.position;
    this.onRest?.(id, [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]);
  }
}
