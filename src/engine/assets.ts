/**
 * Runtime asset library for the CC0 assets produced by scripts/fetch-assets.mjs.
 * Everything is optional: if an asset is missing, callers keep their procedural fallback.
 */
import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE = '/assets';

interface Manifest { models: string[]; textures: string[]; hdris: string[]; space?: string[] }

class AssetLibrary {
  manifest: Manifest = { models: [], textures: [], hdris: [], space: [] };
  private spaceCache = new Map<string, THREE.Texture | null>();
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private tex = new THREE.TextureLoader();
  private models = new Map<string, Promise<GLTF | null>>();
  private sets = new Map<string, { map: THREE.Texture; normalMap: THREE.Texture; arm: THREE.Texture } | null>();
  private ready?: Promise<void>;

  init() {
    this.ready ??= fetch(`${BASE}/manifest.json`).then((r) => (r.ok ? r.json() : this.manifest)).then((m) => { this.manifest = m; }).catch(() => {});
    return this.ready;
  }

  has(kind: keyof Manifest, id: string) {
    return (this.manifest[kind] ?? []).includes(id);
  }

  /** Planetary / sky imagery (Solar System Scope, CC BY 4.0). Null if not downloaded. */
  space(file: string, colour = true): THREE.Texture | null {
    if (!this.spaceCache.has(file)) {
      if (!this.has('space', file)) this.spaceCache.set(file, null);
      else {
        const t = this.tex.load(`${BASE}/space/${file}`);
        if (colour) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        this.spaceCache.set(file, t);
      }
    }
    return this.spaceCache.get(file)!;
  }

  model(id: string): Promise<GLTF | null> {
    if (!this.models.has(id)) {
      this.models.set(id, this.has('models', id) ? this.gltf.loadAsync(`${BASE}/models/${id}.glb`).catch((e) => { console.warn('asset', id, e); return null; }) : Promise.resolve(null));
    }
    return this.models.get(id)!;
  }

  /**
   * Instance a (possibly multi-mesh) model at many transforms. Each mesh in the
   * glTF becomes one InstancedMesh, so 500 trees cost a handful of draw calls.
   */
  async instanced(id: string, transforms: THREE.Matrix4[], opts: { shadows?: boolean; patch?: (m: THREE.MeshStandardMaterial) => void } = {}): Promise<THREE.Group | null> {
    const g = await this.model(id);
    if (!g || !transforms.length) return null;
    const group = new THREE.Group();
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
      for (const mat of mats) {
        if (mat.map) mat.map.anisotropy = 8;
        opts.patch?.(mat);
      }
      // Split into spatial quadrants so frustum culling can drop what is behind the camera.
      const parts: THREE.Matrix4[][] = transforms.length > 24 ? [[], [], [], []] : [transforms];
      if (parts.length === 4) for (const t of transforms) {
        const x = t.elements[12], z = t.elements[14];
        parts[(x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0)].push(t);
      }
      const tmp = new THREE.Matrix4();
      for (const part of parts) {
        if (!part.length) continue;
        const im = new THREE.InstancedMesh(m.geometry, m.material, part.length);
        part.forEach((t, i) => im.setMatrixAt(i, tmp.multiplyMatrices(t, m.matrixWorld)));
        im.castShadow = opts.shadows ?? true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
      }
    });
    return group;
  }

  /** A single deep clone of a model (for unique props). */
  async clone(id: string): Promise<THREE.Object3D | null> {
    const g = await this.model(id);
    if (!g) return null;
    const c = g.scene.clone(true);
    c.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return c;
  }

  /** Height of a model's bounding box (to scale assets to a target size). */
  async size(id: string) {
    const g = await this.model(id);
    return g ? new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3()) : null;
  }

  private textureSet(id: string) {
    if (!this.sets.has(id)) {
      if (!this.has('textures', id)) this.sets.set(id, null);
      else {
        const load = (f: string, srgb: boolean) => {
          const t = this.tex.load(`${BASE}/textures/${id}/${f}.jpg`);
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          return t;
        };
        this.sets.set(id, { map: load('diff', true), normalMap: load('nor', false), arm: load('arm', false) });
      }
    }
    return this.sets.get(id)!;
  }

  /** Upgrade an existing material in place with a scanned PBR set. Returns false if unavailable. */
  applyTo(m: THREE.MeshStandardMaterial, id: string, repeat = 1, normalScale = 1): boolean {
    const s = this.textureSet(id);
    if (!s) return false;
    const r = (t: THREE.Texture) => {
      const x = repeat === 1 ? t : t.clone();
      x.repeat.set(repeat, repeat);
      x.needsUpdate = true;
      return x;
    };
    m.map = r(s.map);
    m.normalMap = r(s.normalMap);
    m.roughnessMap = r(s.arm);
    m.aoMap = r(s.arm);
    m.aoMapIntensity = 0.8;
    m.metalnessMap = null;
    m.metalness = 0;
    m.roughness = 1;
    m.normalScale.set(normalScale, normalScale);
    m.color.set('#ffffff');
    m.needsUpdate = true;
    return true;
  }

  /** Load an HDRI and find the direction of its sun (brightest region) for matching the key light. */
  async hdri(id: string): Promise<{ texture: THREE.DataTexture; sunDir: THREE.Vector3; horizon: THREE.Color; zenith: THREE.Color } | null> {
    if (!this.has('hdris', id)) return null;
    try {
      const texture = await new RGBELoader().loadAsync(`${BASE}/hdri/${id}.hdr`);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const { data, width, height } = texture.image as unknown as { data: Uint16Array | Float32Array; width: number; height: number };
      const half = data instanceof Uint16Array;
      const val = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
      let best = -1, bx = 0, by = 0;
      for (let y = 0; y < height / 2; y += 2) for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const l = val(i) * 0.2126 + val(i + 1) * 0.7152 + val(i + 2) * 0.0722;
        if (l > best) { best = l; bx = x; by = y; }
      }
      // equirect → direction (three.js convention)
      const u = bx / width, v = by / height;
      const phi = u * Math.PI * 2, theta = v * Math.PI;
      const sunDir = new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), -Math.sin(phi) * Math.sin(theta)).normalize();
      // average colours near the horizon and the zenith (for fog / ambient matching)
      const avgRow = (row: number) => {
        const c = new THREE.Color(0, 0, 0);
        let n = 0;
        for (let x = 0; x < width; x += 8) {
          const i = (row * width + x) * 4;
          const r = val(i), g = val(i + 1), b = val(i + 2);
          if (r + g + b > best * 0.05) continue; // skip the sun itself
          c.r += r; c.g += g; c.b += b; n++;
        }
        return c.multiplyScalar(1 / Math.max(1, n));
      };
      const horizon = avgRow(Math.floor(height * 0.49));
      const zenith = avgRow(Math.floor(height * 0.08));
      return { texture, sunDir, horizon, zenith };
    } catch (e) {
      console.warn('hdri', id, e);
      return null;
    }
  }
}

export const assets = new AssetLibrary();

/** Build a transform matrix from position / yaw / uniform scale. */
export function place(x: number, y: number, z: number, yaw = 0, s = 1, tilt = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, tilt * 0.5)), new THREE.Vector3(s, s, s));
}
