/**
 * An endless field of liquid water at molecular scale.
 *
 * Coordinates are in Bohr radii inside a periodic box; each frame the box is
 * re-centred on the camera (a floating origin), so the liquid extends in every
 * direction without precision loss or visible edges.
 *
 * Motion model (stated in the UI): rigid TIP-geometry molecules with Langevin
 * thermal dynamics — friction plus random kicks whose strength follows
 * temperature — rotational diffusion, and a short-range O–O repulsion. This is
 * a physically motivated APPROXIMATION, not a full molecular-dynamics force field
 * (no electrostatics, no polarisation). Hydrogen bonds are detected with the
 * standard geometric criterion (H···O < 2.5 Å) from the current positions.
 */
import * as THREE from 'three';
import { WATER, A0_M } from './atomScales';
import { QUALITY } from '../engine/quality';

const ANG = 1e-10 / A0_M; // 1 Å in Bohr radii
const H_OFFSETS = [WATER.H1.clone().sub(WATER.O), WATER.H2.clone().sub(WATER.O)];

export interface PickedAtom { molecule: number; atom: 'O' | 'H1' | 'H2'; position: THREE.Vector3 }

export class WaterField {
  group = new THREE.Group();
  readonly N: number;
  readonly box: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private quat: THREE.Quaternion[] = [];
  private angVel: THREE.Vector3[] = [];
  private oMesh: THREE.InstancedMesh;
  private hMesh: THREE.InstancedMesh;
  private bondMesh: THREE.InstancedMesh;
  private hbonds: THREE.LineSegments;
  private hbPos: Float32Array;
  /** molecule hidden because it is being shown in the quantum view */
  hidden = -1;
  temperature = 300;
  hbondCount = 0;
  private renderPos: THREE.Vector3[] = [];

  constructor() {
    this.N = QUALITY.low ? 700 : 2500;
    // liquid water: 33.4 molecules per nm³
    this.box = Math.cbrt(this.N / 33.4) * 1e-9 / A0_M;
    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    // start on a jittered lattice (no overlaps), random orientations
    const n = Math.ceil(Math.cbrt(this.N));
    const cell = this.box / n;
    for (let i = 0; i < this.N; i++) {
      const x = i % n, y = Math.floor(i / n) % n, z = Math.floor(i / (n * n));
      this.pos.set([(x + 0.5 + (Math.random() - 0.5) * 0.3) * cell - this.box / 2, (y + 0.5 + (Math.random() - 0.5) * 0.3) * cell - this.box / 2, (z + 0.5 + (Math.random() - 0.5) * 0.3) * cell - this.box / 2], i * 3);
      this.quat.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28)));
      this.angVel.push(new THREE.Vector3());
      this.renderPos.push(new THREE.Vector3());
    }
    const seg = QUALITY.low ? 1 : 2;
    const sphere = new THREE.IcosahedronGeometry(1, seg);
    const glossy = (c: string, sheen = 0) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.22, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08, sheen, envMapIntensity: 1.4 });
    // CPK colours: oxygen red, hydrogen white. Ball radii ≈ 0.42× covalent-scaled (ball-and-stick).
    this.oMesh = new THREE.InstancedMesh(sphere, glossy('#e0402c'), this.N);
    this.hMesh = new THREE.InstancedMesh(sphere, glossy('#f2f4ff', 0.3), this.N * 2);
    const bondGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    bondGeo.translate(0, 0.5, 0);
    this.bondMesh = new THREE.InstancedMesh(bondGeo, glossy('#c9c4d6'), this.N * 2);
    for (const m of [this.oMesh, this.hMesh, this.bondMesh]) {
      m.frustumCulled = false;
      m.userData.waterField = true;
      this.group.add(m);
    }
    this.hbPos = new Float32Array(this.N * 4 * 3 * 2);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.hbPos, 3));
    this.hbonds = new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: '#7df9ff', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.hbonds.frustumCulled = false;
    this.group.add(this.hbonds);
  }

  /** Langevin thermal dynamics in visual time (1 s on screen ≈ 0.1 ps of real time). */
  step(dt: number) {
    if (dt <= 0) return;
    const N = this.N, B = this.box, p = this.pos, v = this.vel;
    const T = this.temperature / 300;
    const gamma = 2.2, sigma = Math.sqrt(2 * gamma * T) * 2.4;
    const sq = Math.sqrt(dt);
    // spatial hash for short-range O–O repulsion (contact ≈ 2.6 Å)
    const rc = 2.6 * ANG, cells = Math.max(1, Math.floor(B / rc));
    const cellOf = (x: number) => ((Math.floor((x / B + 0.5) * cells) % cells) + cells) % cells;
    const grid = new Map<number, number[]>();
    for (let i = 0; i < N; i++) {
      const k = cellOf(p[i * 3]) + cells * (cellOf(p[i * 3 + 1]) + cells * cellOf(p[i * 3 + 2]));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
    for (let i = 0; i < N; i++) {
      let fx = 0, fy = 0, fz = 0;
      const cx = cellOf(p[i * 3]), cy = cellOf(p[i * 3 + 1]), cz = cellOf(p[i * 3 + 2]);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const list = grid.get(((cx + a + cells) % cells) + cells * (((cy + b + cells) % cells) + cells * ((cz + c + cells) % cells)));
        if (!list) continue;
        for (const j of list) {
          if (j === i) continue;
          let dx = p[i * 3] - p[j * 3], dy = p[i * 3 + 1] - p[j * 3 + 1], dz = p[i * 3 + 2] - p[j * 3 + 2];
          dx -= B * Math.round(dx / B); dy -= B * Math.round(dy / B); dz -= B * Math.round(dz / B);
          const r = Math.hypot(dx, dy, dz);
          if (r < rc && r > 1e-6) {
            const f = ((rc - r) / rc) * 40; // soft repulsion
            fx += (dx / r) * f; fy += (dy / r) * f; fz += (dz / r) * f;
          }
        }
      }
      for (let k = 0; k < 3; k++) {
        const f = k === 0 ? fx : k === 1 ? fy : fz;
        v[i * 3 + k] += (-gamma * v[i * 3 + k] + f) * dt + sigma * sq * (Math.random() * 2 - 1) * 1.73;
        p[i * 3 + k] += v[i * 3 + k] * dt;
        // keep inside the periodic box
        if (p[i * 3 + k] > B / 2) p[i * 3 + k] -= B; else if (p[i * 3 + k] < -B / 2) p[i * 3 + k] += B;
      }
      // rotational diffusion (librations)
      const w = this.angVel[i];
      w.multiplyScalar(Math.exp(-gamma * 1.5 * dt)).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(sigma * sq * 1.2));
      const ang = w.length() * dt;
      if (ang > 0) this.quat[i].premultiply(new THREE.Quaternion().setFromAxisAngle(w.clone().normalize(), ang));
    }
  }

  /**
   * Upload instance transforms around the camera. S = scene units per Bohr radius;
   * `origin` (a₀) is the floating origin used when an atom is being inspected.
   */
  layout(S: number, cam: THREE.Vector3, origin: THREE.Vector3, opacity: number) {
    this.group.visible = opacity > 0.01;
    if (!this.group.visible) return;
    const N = this.N, B = this.box, p = this.pos;
    const camA = cam.clone().divideScalar(S).add(origin);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const rO = 0.62 * ANG * S, rH = 0.36 * ANG * S, rB = 0.12 * ANG * S;
    let hb = 0;
    const hAt: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      let dx = p[i * 3] - camA.x, dy = p[i * 3 + 1] - camA.y, dz = p[i * 3 + 2] - camA.z;
      dx -= B * Math.round(dx / B); dy -= B * Math.round(dy / B); dz -= B * Math.round(dz / B);
      const o = this.renderPos[i].set(camA.x + dx - origin.x, camA.y + dy - origin.y, camA.z + dz - origin.z); // a₀, relative to origin
      const hide = i === this.hidden ? 0 : 1;
      m4.compose(o.clone().multiplyScalar(S), q.identity(), sc.setScalar(rO * hide));
      this.oMesh.setMatrixAt(i, m4);
      for (let h = 0; h < 2; h++) {
        const hp = H_OFFSETS[h].clone().applyQuaternion(this.quat[i]).add(o);
        hAt[i * 2 + h] = hp;
        m4.compose(hp.clone().multiplyScalar(S), q.identity(), sc.setScalar(rH * hide));
        this.hMesh.setMatrixAt(i * 2 + h, m4);
        const dir = hp.clone().sub(o);
        m4.compose(o.clone().multiplyScalar(S), q.setFromUnitVectors(up, dir.clone().normalize()), sc.set(rB * hide, dir.length() * S, rB * hide));
        this.bondMesh.setMatrixAt(i * 2 + h, m4);
      }
    }
    // hydrogen bonds: H···O within 2.5 Å of a different molecule (spatial hash on O)
    const rhb = 2.5 * ANG, cellSz = rhb;
    const key = (v: THREE.Vector3) => `${Math.floor(v.x / cellSz)},${Math.floor(v.y / cellSz)},${Math.floor(v.z / cellSz)}`;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < N; i++) { const k = key(this.renderPos[i]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    const maxLines = this.hbPos.length / 6;
    for (let i = 0; i < N * 2 && hb < maxLines; i++) {
      const h = hAt[i];
      if (!h || Math.floor(i / 2) === this.hidden) continue;
      const bx = Math.floor(h.x / cellSz), by = Math.floor(h.y / cellSz), bz = Math.floor(h.z / cellSz);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        for (const j of grid.get(`${bx + a},${by + b},${bz + c}`) ?? []) {
          if (j === Math.floor(i / 2) || j === this.hidden) continue;
          const o = this.renderPos[j];
          const d = h.distanceTo(o);
          if (d < rhb && d > 1.5 * ANG && hb < maxLines) {
            this.hbPos.set([h.x * S, h.y * S, h.z * S, o.x * S, o.y * S, o.z * S], hb * 6);
            hb++;
          }
        }
      }
    }
    this.hbondCount = hb;
    this.hbonds.geometry.setDrawRange(0, hb * 2);
    this.hbonds.geometry.attributes.position.needsUpdate = true;
    (this.hbonds.material as THREE.LineBasicMaterial).opacity = 0.4 * opacity;
    for (const mm of [this.oMesh, this.hMesh, this.bondMesh]) {
      mm.instanceMatrix.needsUpdate = true;
      const mat = mm.material as THREE.MeshPhysicalMaterial;
      mat.transparent = opacity < 0.999;
      mat.opacity = opacity;
    }
  }

  /** Resolve a raycast hit on the field to a specific atom (position in a₀ relative to the current origin). */
  pick(hit: THREE.Intersection): PickedAtom | null {
    if (hit.instanceId === undefined) return null;
    if (hit.object === this.oMesh) return { molecule: hit.instanceId, atom: 'O', position: this.renderPos[hit.instanceId].clone() };
    if (hit.object === this.hMesh) {
      const m = Math.floor(hit.instanceId / 2);
      const hp = H_OFFSETS[hit.instanceId % 2].clone().applyQuaternion(this.quat[m]).add(this.renderPos[m]);
      return { molecule: m, atom: hit.instanceId % 2 ? 'H2' : 'H1', position: hp };
    }
    return null;
  }

  get pickTargets() {
    return [this.oMesh, this.hMesh];
  }

  orientation(i: number) {
    return this.quat[i].clone();
  }

  /** absolute (box) position of molecule i's oxygen, a₀ */
  absPos(i: number) {
    return new THREE.Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }
}
