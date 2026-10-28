import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { assets } from "../engine/assets";
import { QUALITY } from "../engine/quality";

/** A built, human-scale space: separate limestone, granite, bronze and water.
 * Instances keep the joint geometry and edge highlights inexpensive. */
export function nexusArchitecture() {
  const group = new T.Group();
  const limestone = new T.MeshStandardMaterial({
    color: "#b1aa9b",
    roughness: 0.82,
  });
  const paving = new T.MeshStandardMaterial({
    color: "#9c9a92",
    roughness: 0.57,
  });
  const bronze = new T.MeshStandardMaterial({
    color: "#95816a",
    metalness: 0.78,
    roughness: 0.36,
  });
  const foundation = new T.MeshStandardMaterial({
    color: "#66625a",
    roughness: 0.88,
  });
  const add = (
    geometry: T.BufferGeometry,
    material: T.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new T.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // The dark joints come from actual gaps, rather than a giant tiled photograph.
  add(new T.CylinderGeometry(22.6, 22.8, 0.65, 160), foundation, 0, -0.44, 0);
  add(new T.CylinderGeometry(23.2, 23.5, 0.35, 160), foundation, 0, -0.93, 0);
  const spots: [number, number][] = [];
  for (let x = -19; x <= 19; x++)
    for (let z = -19; z <= 19; z++) {
      const px = x * 1.12,
        pz = z * 1.12;
      if (Math.hypot(px, pz) < 18.3) spots.push([px, pz]);
    }
  const floor = new T.InstancedMesh(
    new RoundedBoxGeometry(1.102, 0.16, 1.102, 2, 0.018),
    paving,
    spots.length,
  );
  const matrix = new T.Matrix4(),
    colour = new T.Color();
  spots.forEach(([x, z], i) => {
    matrix.makeRotationY(((i % 4) * Math.PI) / 2);
    matrix.setPosition(x, -0.075, z);
    floor.setMatrixAt(i, matrix);
    floor.setColorAt(i, colour.setScalar(0.86 + (((i * 71) % 97) / 97) * 0.19));
  });
  floor.castShadow = floor.receiveShadow = true;
  floor.computeBoundingSphere();
  group.add(floor);
  // Inlaid metal bands terminate the paving and make its scale legible.
  for (const r of [3.15, 18.85, 21.5, 22.4]) {
    const ring = add(
      new T.TorusGeometry(r, r < 4 ? 0.018 : 0.045, 8, 192),
      bronze,
      0,
      0.005,
      0,
    );
    ring.rotation.x = Math.PI / 2;
  }
  if (QUALITY.reflections) {
    const water = new Reflector(new T.RingGeometry(19.1, 21.35, 160), {
      textureWidth: QUALITY.ultra ? 1024 : 512,
      textureHeight: QUALITY.ultra ? 1024 : 512,
      multisample: 0,
      color: 0x53666a,
      clipBias: 0.006,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.025;
    const capture = water.onBeforeRender;
    let last = -Infinity;
    water.onBeforeRender = (...args) => {
      const now = performance.now();
      if (now - last < 1000 / (QUALITY.ultra ? 30 : 15)) return;
      last = now;
      const renderer = args[0],
        auto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      try {
        capture.apply(water, args);
      } finally {
        renderer.shadowMap.autoUpdate = auto;
      }
    };
    group.add(water);
  }
  // Fluted shafts, entasis, capitals and individual voussoirs give the outer
  // arcade a real construction scale and a readable silhouette at every angle.
  const count = 16,
    radius = 24.5;
  const shaft = new T.CylinderGeometry(0.53, 0.66, 10.6, 48, 12);
  const vertices = shaft.attributes.position as T.BufferAttribute;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i),
      z = vertices.getZ(i),
      y = vertices.getY(i),
      a = Math.atan2(z, x);
    const f =
      1 +
      0.037 * Math.cos(a * 16) +
      0.022 * Math.sin((y / 10.6 + 0.5) * Math.PI);
    vertices.setXYZ(i, x * f, y, z * f);
  }
  shaft.computeVertexNormals();
  const shaftUv = shaft.attributes.uv as T.BufferAttribute;
  for (let i = 0; i < shaftUv.count; i++)
    shaftUv.setXY(i, shaftUv.getX(i) * 3.6, (vertices.getY(i) + 5.3) / 1.4);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2,
      x = Math.cos(a) * radius,
      z = Math.sin(a) * radius;
    add(shaft, limestone, x, 6.3, z);
    for (const [y, w, h] of [
      [0.2, 1.9, 0.4],
      [0.55, 1.6, 0.3],
      [11.8, 1.6, 0.3],
      [12.15, 1.9, 0.38],
    ])
      add(new RoundedBoxGeometry(w, h, w, 2, 0.035), limestone, x, y, z);
    for (const y of [0.85, 11.55]) {
      const torus = add(
        new T.TorusGeometry(0.69, 0.1, 10, 48),
        limestone,
        x,
        y,
        z,
      );
      torus.rotation.x = Math.PI / 2;
    }
    const b = ((i + 0.5) / count) * Math.PI * 2,
      chord = 2 * radius * Math.sin(Math.PI / count),
      archR = chord / 2;
    const arch = new T.Group();
    arch.position.set(
      Math.cos(b) * radius * Math.cos(Math.PI / count),
      12.3,
      Math.sin(b) * radius * Math.cos(Math.PI / count),
    );
    arch.rotation.y = -b - Math.PI / 2;
    for (let k = 0; k < 17; k++) {
      const theta = ((k + 0.5) / 17) * Math.PI;
      const block = new T.Mesh(
        new RoundedBoxGeometry(
          (archR * Math.PI) / 17 - 0.025,
          0.55,
          0.83,
          2,
          0.025,
        ),
        limestone,
      );
      block.position.set(Math.cos(theta) * archR, Math.sin(theta) * archR, 0);
      block.rotation.z = theta - Math.PI / 2;
      block.castShadow = block.receiveShadow = true;
      arch.add(block);
    }
    group.add(arch);
  }
  void assets.init().then(() => {
    assets.applyTo(limestone, "concrete_floor_02", 1, 0.35);
    limestone.color.set("#c5c0b4");
    assets.applyTo(paving, "marble_01", 1, 0.2);
    paving.roughness = 0.52;
    paving.color.set("#a5a39e");
    assets.applyTo(foundation, "concrete_floor_02", 7, 0.6);
    foundation.color.set("#807e76");
  });
  return group;
}
