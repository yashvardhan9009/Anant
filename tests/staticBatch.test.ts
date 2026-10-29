import { describe, it, expect } from "vitest";
import * as T from "three";
import { batchStatic } from "../src/engine/StaticBatch";
describe("Static prop batching", () => {
  it("reduces draw objects without changing transformed bounds or material", () => {
    const root = new T.Group();
    root.position.set(7, 2, -4);
    root.rotation.y = 0.7;
    root.scale.set(2, 1.2, 0.6);
    const mat = new T.MeshStandardMaterial();
    for (let i = 0; i < 9; i++) {
      const mesh = new T.Mesh(new T.BoxGeometry(1, 2, 0.3), mat);
      mesh.position.set(i - 4, i * 0.1, 0);
      mesh.rotation.z = i * 0.05;
      mesh.castShadow = mesh.receiveShadow = true;
      root.add(mesh);
    }
    const before = new T.Box3().setFromObject(root);
    batchStatic(root);
    const after = new T.Box3().setFromObject(root);
    expect(root.children).toHaveLength(1);
    expect((root.children[0] as T.Mesh).material).toBe(mat);
    expect(before.min.distanceTo(after.min)).toBeLessThan(1e-5);
    expect(before.max.distanceTo(after.max)).toBeLessThan(1e-5);
  });
  it("retains instanced, transparent and vertex-coloured meshes", () => {
    const root = new T.Group(),
      g = new T.BoxGeometry(),
      solid = new T.MeshBasicMaterial(),
      transparent = new T.MeshBasicMaterial({ transparent: true }),
      vertex = new T.MeshBasicMaterial({ vertexColors: true });
    const glass = new T.Mesh(g, transparent),
      instances = new T.InstancedMesh(g, solid, 2),
      coloured = new T.Mesh(g, vertex);
    root.add(glass, instances, coloured);
    batchStatic(root);
    expect(root.children).toEqual([glass, instances, coloured]);
  });
  it("does not combine different shadow contracts", () => {
    const root = new T.Group(),
      m = new T.MeshStandardMaterial();
    for (let i = 0; i < 4; i++) {
      const mesh = new T.Mesh(new T.BoxGeometry(), m);
      mesh.castShadow = i < 2;
      root.add(mesh);
    }
    batchStatic(root);
    expect(root.children).toHaveLength(2);
    expect(root.children.filter((o) => o.castShadow)).toHaveLength(1);
  });
});
