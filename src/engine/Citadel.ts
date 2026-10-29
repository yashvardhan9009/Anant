import * as T from "three";
import type { Built } from "./objects";
import { worldBox, addWind } from "./architecture";
import { batchStatic } from "./StaticBatch";
import { assets } from "./assets";

/** Masonry, machicolations, recessed openings, roof courses and an authored gate. */
export function buildCitadel(color: string): Built {
  const root = new T.Group();
  root.name = "Masonry citadel";
  const stone = new T.MeshStandardMaterial({ color, roughness: 0.9 }),
    trim = new T.MeshStandardMaterial({ color: "#9f9686", roughness: 0.85 }),
    roof = new T.MeshStandardMaterial({ color: "#514f49", roughness: 0.87 });
  const iron = new T.MeshStandardMaterial({
      color: "#24272a",
      metalness: 0.8,
      roughness: 0.42,
    }),
    dark = new T.MeshStandardMaterial({ color: "#111418", roughness: 0.85 });
  const add = (
    geo: T.BufferGeometry,
    mat: T.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new T.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  const box = (
    w: number,
    h: number,
    d: number,
    mat: T.Material,
    x: number,
    y: number,
    z: number,
  ) => add(worldBox(w, h, d, 0.65), mat, x, y, z);
  box(5.8, 0.2, 5.7, trim, 0, 0.1, 0);
  // Main keep with a pitched roof and physical eave courses.
  box(2.3, 3.4, 0.18, stone, 0, 1.9, -1.56);
  for (const side of [-1, 1])
    box(0.18, 3.4, 2.5, stone, side * 1.06, 1.9, -0.4);
  box(1.9, 3.2, 2.1, dark, 0, 1.85, -0.4);
  const facade = new T.Shape();
  facade.moveTo(-1.15, 0);
  facade.lineTo(1.15, 0);
  facade.lineTo(1.15, 3.4);
  facade.lineTo(-1.15, 3.4);
  facade.closePath();
  for (const x of [-0.65, 0.65])
    for (let floor = 0; floor < 3; floor++) {
      const y = 1 + floor * 0.85,
        hole = new T.Path();
      hole.moveTo(x - 0.105, y - 0.245);
      hole.lineTo(x - 0.105, y + 0.245);
      hole.lineTo(x + 0.105, y + 0.245);
      hole.lineTo(x + 0.105, y - 0.245);
      hole.closePath();
      facade.holes.push(hole);
    }
  add(
    new T.ExtrudeGeometry(facade, {
      depth: 0.16,
      bevelEnabled: true,
      bevelSize: 0.01,
      bevelThickness: 0.01,
      bevelSegments: 1,
    }),
    stone,
    0,
    0.2,
    0.69,
  );
  for (let level = 0; level < 4; level++) {
    const cone = add(
      new T.ConeGeometry(1.85 - level * 0.3, 0.7, 4),
      roof,
      0,
      3.8 + level * 0.48,
      -0.4,
    );
    cone.rotation.y = Math.PI / 4;
  }
  for (const side of [-1, 1])
    for (let floor = 0; floor < 3; floor++) {
      const y = 1.2 + floor * 0.85;
      box(0.21, 0.49, 0.02, dark, side * 0.65, y, 0.76);
      for (const x of [-0.14, 0.14])
        box(0.055, 0.57, 0.09, trim, side * 0.65 + x, y, 0.91);
      box(0.4, 0.06, 0.17, trim, side * 0.65, y - 0.28, 0.94);
      const arch = add(
        new T.TorusGeometry(0.14, 0.034, 6, 24, Math.PI),
        trim,
        side * 0.65,
        y + 0.25,
        0.91,
      );
    }
  for (const [x, z] of [
    [-2.2, -2.15],
    [2.2, -2.15],
    [-2.2, 2.15],
    [2.2, 2.15],
  ]) {
    add(new T.CylinderGeometry(0.61, 0.75, 3.6, 48, 5), stone, x, 2, z);
    for (const y of [0.32, 0.65, 2.92, 3.78])
      add(new T.CylinderGeometry(0.72, 0.75, 0.13, 48), trim, x, y, z);
    // Corbel-supported parapet with deep crenellations.
    add(new T.CylinderGeometry(0.83, 0.62, 0.35, 48), trim, x, 3.6, z);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const block = box(
        0.22,
        0.34,
        0.25,
        stone,
        x + Math.sin(a) * 0.69,
        4.0,
        z + Math.cos(a) * 0.69,
      );
      block.rotation.y = a;
      if (i % 2 === 0) {
        const slit = box(
          0.1,
          0.45,
          0.04,
          dark,
          x + Math.sin(a) * 0.625,
          2.5,
          z + Math.cos(a) * 0.625,
        );
        slit.rotation.y = a;
      }
    }
    for (let y = 0.9; y < 3.3; y += 0.45)
      add(
        new T.CylinderGeometry(0.618, 0.618, 0.016, 48, 1, true),
        trim,
        x,
        y,
        z,
      );
  }
  // Separate entrance piers leave a real opening; the door model sits behind it.
  for (const side of [-1, 1]) {
    box(1.6, 1.8, 0.46, stone, side * 1.55, 1.1, 2.15);
    box(0.46, 1.8, 4.25, stone, side * 2.2, 1.1, 0);
    for (let i = 0; i < 9; i++)
      box(0.25, 0.34, 0.48, stone, side * 2.2, 2.18, -1.9 + i * 0.48);
    for (let i = 0; i < 4; i++)
      box(0.26, 0.34, 0.48, stone, side * (0.9 + i * 0.4), 2.18, 2.15);
    for (let i = 0; i < 3; i++)
      box(0.18, 2.35, 0.28, trim, side * (0.85 + i * 0.62), 1.3, 2.41);
  }
  box(4.4, 1.8, 0.46, stone, 0, 1.1, -2.15);
  for (let i = 0; i < 11; i++)
    box(0.26, 0.34, 0.48, stone, -2 + i * 0.4, 2.18, -2.15);
  const shape = new T.Shape();
  shape.moveTo(-0.64, 0);
  shape.lineTo(-0.64, 1.3);
  shape.absarc(0, 1.3, 0.64, Math.PI, 0, true);
  shape.lineTo(0.64, 0);
  shape.closePath();
  const opening = new T.Path();
  opening.moveTo(-0.47, 0.02);
  opening.lineTo(0.47, 0.02);
  opening.lineTo(0.47, 1.26);
  opening.absarc(0, 1.26, 0.47, 0, Math.PI, false);
  opening.closePath();
  shape.holes.push(opening);
  const entrance = add(
    new T.ExtrudeGeometry(shape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelSize: 0.035,
      bevelThickness: 0.025,
      bevelSegments: 2,
    }),
    trim,
    0,
    0.2,
    2.28,
  );
  // The dark, inset opening remains behind the ornamental arch rather than a luminous rectangle.
  const door = box(1.05, 1.6, 0.08, dark, 0, 1, 2.29);
  for (let i = 0; i < 6; i++)
    box(0.045, 1.55, 0.04, iron, -0.45 + i * 0.18, 0.99, 2.36);
  for (const y of [0.55, 1.45]) box(1.1, 0.075, 0.08, iron, 0, y, 2.37);
  for (let i = 0; i < 3; i++)
    box(
      1.7 - i * 0.18,
      0.09,
      0.9 - i * 0.22,
      trim,
      0,
      0.045 + i * 0.09,
      2.78 - i * 0.1,
    );
  batchStatic(root);
  const cloth = new T.MeshStandardMaterial({
    color: "#7d293a",
    roughness: 0.97,
    side: T.DoubleSide,
  });
  addWind(cloth, "cloth");
  const flag = new T.Mesh(new T.PlaneGeometry(0.65, 0.9, 8, 14), cloth);
  flag.position.set(0.32, 5.7, -0.4);
  root.add(flag);
  const pole = add(
    new T.CylinderGeometry(0.02, 0.025, 1.5, 12),
    iron,
    0,
    5.65,
    -0.4,
  );
  let closed = false;
  const ready = assets.init().then(async () => {
    if (closed) return;
    assets.applyTo(stone, "stone_wall_04", 1, 0.55);
    stone.color.set(color);
    assets.applyTo(trim, "concrete_floor_02", 1, 0.24);
    trim.color.set("#b0a89a");
    assets.applyTo(roof, "roof_slates_02", 1, 0.65);
    roof.color.set("#5d6265");
    root.userData.detailReady = true;
  });
  return {
    root,
    tint: [stone],
    base: 0,
    ready,
    dispose: () => {
      closed = true;
    },
  };
}
