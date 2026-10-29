import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { batchStatic } from "./StaticBatch";

/** Wrought cage and actual small emitter, instead of a whole luminous cube. */
export function lanternHead() {
  const root = new T.Group();
  root.name = "Caged glass lantern";
  const iron = new T.MeshStandardMaterial({
    color: "#24282b",
    roughness: 0.42,
    metalness: 0.85,
  });
  const brass = new T.MeshStandardMaterial({
    color: "#94754a",
    roughness: 0.38,
    metalness: 0.8,
  });
  const wax = new T.MeshStandardMaterial({ color: "#b7a789", roughness: 0.87 });
  const flame = new T.MeshStandardMaterial({
    color: "#fff1b8",
    emissive: "#ffc372",
    emissiveIntensity: 3,
    roughness: 1,
  });
  const add = (
    g: T.BufferGeometry,
    m: T.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new T.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  for (const y of [-0.25, 0.25])
    add(new RoundedBoxGeometry(0.39, 0.045, 0.39, 1, 0.012), iron, 0, y, 0);
  for (const x of [-0.16, 0.16])
    for (const z of [-0.16, 0.16])
      add(new T.CylinderGeometry(0.012, 0.017, 0.5, 8), iron, x, 0, z);
  add(new T.ConeGeometry(0.3, 0.19, 4).rotateY(Math.PI / 4), iron, 0, 0.36, 0);
  add(new T.CylinderGeometry(0.055, 0.06, 0.12, 12), brass, 0, 0.5, 0);
  const hoop = add(new T.TorusGeometry(0.065, 0.01, 6, 20), iron, 0, 0.59, 0);
  add(new T.CylinderGeometry(0.04, 0.045, 0.18, 12), wax, 0, -0.13, 0);
  const wick = add(new T.SphereGeometry(0.024, 12, 8), flame, 0, -0.016, 0);
  wick.scale.y = 2.6;
  wick.castShadow = false;
  const pane = add(
    new RoundedBoxGeometry(0.31, 0.46, 0.31, 1, 0.008),
    new T.MeshPhysicalMaterial({
      color: "#b7c2bd",
      transparent: true,
      opacity: 0.13,
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      depthWrite: false,
    }),
    0,
    0,
    0,
  );
  pane.castShadow = false;
  root.userData.flame = flame;
  return batchStatic(root);
}
