import * as T from "three";
import { assets } from "../engine/assets";
import { QUALITY } from "../engine/quality";
import { addWind } from "../engine/architecture";
import {
  Masonry,
  inscriptionTexture,
  wetFloor,
  type NexusMaterials,
} from "./NexusCraft";

/** A navigable, 72 metre hall. Repeated construction details share batches. */
export function nexusArchitecture(m: NexusMaterials) {
  const group = new T.Group();
  group.name = "Nexus monumental hall";
  const b = new Masonry();
  const positions: [number, number][] = [];
  for (let x = -15; x <= 15; x++)
    for (let z = -15; z <= 15; z++)
      if (Math.hypot(x * 2.4, z * 2.4) < 35.8)
        positions.push([x * 2.4, z * 2.4]);
  const paving = new T.InstancedMesh(
    new T.BoxGeometry(2.37, 0.18, 2.37),
    m.floor,
    positions.length,
  );
  paving.name = "Jointed wet marble slabs";
  const matrix = new T.Matrix4(),
    color = new T.Color();
  positions.forEach(([x, z], i) => {
    matrix.makeRotationY(((i % 4) * Math.PI) / 2);
    matrix.setPosition(x, -0.09, z);
    paving.setMatrixAt(i, matrix);
    paving.setColorAt(i, color.setScalar(0.74 + (((i * 37) % 97) / 97) * 0.3));
  });
  paving.receiveShadow = true;
  paving.computeBoundingSphere();
  group.add(paving);
  b.add(new T.CylinderGeometry(36, 37, 1.5, 128), m.stone, [0, -0.9, 0]);
  if (QUALITY.reflections) group.add(wetFloor(35.8));
  // Low, walkable steps with real mouldings and metal inlays.
  for (const [r, y, h] of [
    [6, 0.09, 0.18],
    [5.7, 0.25, 0.14],
    [5.4, 0.4, 0.16],
  ] as const) {
    b.add(new T.CylinderGeometry(r, r + 0.08, h, 128), m.iron, [0, y, -2]);
    b.add(
      new T.TorusGeometry(r - 0.12, 0.028, 8, 160),
      m.bronze,
      [0, y + h / 2 + 0.008, -2],
      [Math.PI / 2, 0, 0],
    );
  }
  const inlay = new T.MeshBasicMaterial({
    color: new T.Color("#92b7fa").multiplyScalar(1.5),
  });
  for (const r of [2.9, 3.12, 4.8, 5.25, 16, 32.8, 35.5])
    b.add(
      new T.TorusGeometry(r, r > 6 ? 0.025 : 0.018, 6, 192),
      r === 3.12 || r === 5.25 ? inlay : m.bronze,
      [0, r < 6 ? 0.49 : 0.018, r < 6 ? -2 : 0],
      [Math.PI / 2, 0, 0],
    );
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    b.box(
      [0.018, 0.018, i % 4 ? 0.19 : 0.4],
      m.bronze,
      [Math.cos(a) * 4.96, 0.492, -2 + Math.sin(a) * 4.96],
      [0, -a, 0],
    );
  }
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    b.box(
      [0.035, 0.018, 18],
      m.bronze,
      [Math.sin(a) * 24, 0.018, Math.cos(a) * 24],
      [0, a, 0],
    );
  }
  const inscriptions = inscriptionTexture();
  const engraved = new T.MeshStandardMaterial({
    map: inscriptions,
    color: "#b9ac92",
    roughness: 0.48,
    metalness: 0.55,
  });
  for (const [inner, outer] of [
    [3.35, 4.45],
    [5.02, 5.17],
  ]) {
    const geo = new T.RingGeometry(inner, outer, 192, 2),
      uv = geo.attributes.uv as T.BufferAttribute,
      p = geo.attributes.position as T.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        a = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
      uv.setXY(
        i,
        (Math.hypot(x, y) - inner) / (outer - inner),
        a / (Math.PI * 2),
      );
    }
    const ring = new T.Mesh(geo, engraved);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.493, -2);
    ring.receiveShadow = true;
    group.add(ring);
  }
  const bannerMaterial = new T.MeshStandardMaterial({
    map: inscriptions,
    color: "#8f9eb5",
    roughness: 0.92,
    side: T.DoubleSide,
  });
  addWind(bannerMaterial, "cloth");
  const bannerGeometry = new T.PlaneGeometry(2.3, 14, 8, 32);
  const p = bannerGeometry.attributes.position as T.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i);
    p.setXYZ(
      i,
      x,
      y + (y < -6.8 ? Math.abs(x) * 1.1 : 0),
      Math.sin(x * 7) * 0.07,
    );
  }
  bannerGeometry.computeVertexNormals();
  const count = 16,
    radius = 38;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const tower = new T.Group();
    tower.position.set(Math.sin(a) * radius, 0, Math.cos(a) * radius);
    tower.rotation.y = a;
    const t = new Masonry();
    t.box([2.7, 30, 2.6], m.stone, [0, 15, 0]);
    for (const x of [-1, -0.63, 0.63, 1]) {
      t.add(new T.CylinderGeometry(0.16, 0.24, 27.5, 10, 5), m.edge, [
        x,
        15,
        -1.38,
      ]);
      t.box([0.045, 25.2, 0.05], m.bronze, [x, 14.9, -1.58]);
    }
    for (const [y, w, h] of [
      [0.2, 4.4, 0.4],
      [0.65, 3.8, 0.45],
      [1.15, 3.2, 0.5],
      [28.7, 3.1, 0.35],
      [29.2, 3.7, 0.55],
      [29.8, 4.2, 0.4],
    ]) {
      t.box([w, h, w * 0.75], m.edge, [0, y, 0]);
      t.box([w + 0.04, 0.05, w * 0.75 + 0.04], m.bronze, [0, y + h / 2, 0]);
    }
    for (const side of [-1, 1]) {
      t.box([0.7, 18, 3.8], m.stone, [side * 1.65, 9, 0.9]);
      t.add(new T.ConeGeometry(0.58, 5, 5), m.iron, [side * 1.65, 21, 0.9]);
      t.box([0.22, 9, 0.5], m.edge, [side * 1.65, 23, -0.5]);
    }
    t.add(new T.ConeGeometry(1.1, 7, 5), m.iron, [0, 33.6, 0]);
    t.finish(tower, "Clustered gothic pier");
    const banner = new T.Mesh(bannerGeometry, bannerMaterial);
    banner.position.set(0, 20, -1.8);
    banner.castShadow = true;
    tower.add(banner);
    group.add(tower);
    const next = a + (Math.PI * 2) / count,
      mid = (a + next) / 2;
    const half = radius * Math.sin(Math.PI / count);
    const arch = new T.Group();
    arch.position.set(
      Math.sin(mid) * radius * Math.cos(Math.PI / count),
      0,
      Math.cos(mid) * radius * Math.cos(Math.PI / count),
    );
    arch.rotation.y = mid;
    const ab = new Masonry();
    const curve = new T.CatmullRomCurve3([
      new T.Vector3(-half, 16, 0),
      new T.Vector3(-half * 0.85, 23, 0),
      new T.Vector3(0, 30, 0),
      new T.Vector3(half * 0.85, 23, 0),
      new T.Vector3(half, 16, 0),
    ]);
    const length = curve.getLength();
    for (let j = 0; j < 35; j++) {
      const f = (j + 0.5) / 35,
        point = curve.getPointAt(f),
        tangent = curve.getTangentAt(f);
      ab.box([0.68, length / 35 - 0.035, 1.55], m.edge, point.toArray(), [
        0,
        0,
        -Math.atan2(tangent.x, tangent.y),
      ]);
    }
    for (const z of [-0.85, 0.85])
      ab.add(new T.TubeGeometry(curve, 72, 0.09, 6, false), m.bronze, [
        0,
        0,
        z,
      ]);
    ab.box([half * 2, 0.75, 1.7], m.stone, [0, 31.2, 0]);
    ab.box([half * 2, 0.07, 1.8], m.bronze, [0, 31.65, 0]);
    ab.finish(arch, "Pointed vault ribs");
    group.add(arch);
  }
  b.finish(group);
  group.userData.ready = m.ready.then(async () => {
    const statue = await assets.clone("gothic_statue");
    if (statue) {
      const box = new T.Box3().setFromObject(statue),
        size = box.getSize(new T.Vector3());
      statue.scale.setScalar(3.3 / size.y);
      statue.position.set(
        -box.getCenter(new T.Vector3()).x * statue.scale.x,
        0.49 - box.min.y * statue.scale.y,
        -2 - box.getCenter(new T.Vector3()).z * statue.scale.z,
      );
      statue.rotation.y = Math.PI;
      statue.name = "Scanned central stone figure";
      group.add(statue);
      statue.traverse((o) => {
        if ((o as T.Mesh).isMesh) {
          const mesh = o as T.Mesh;
          const darken = (source: T.Material) => {
            const mat = (source as T.MeshStandardMaterial).clone();
            mat.color.multiplyScalar(0.4);
            mat.roughness = 0.75;
            return mat;
          };
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(darken)
            : darken(mesh.material);
        }
      });
    }
    group.userData.assetsReady = true;
  });
  return group;
}
