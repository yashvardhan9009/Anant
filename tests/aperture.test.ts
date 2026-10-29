import { describe, it, expect } from "vitest";
import * as T from "three";
import { circularRaycast } from "../src/engine/aperture";

function disc() {
  const mesh = new T.Mesh(
    new T.CircleGeometry(6.05),
    new T.MeshBasicMaterial(),
  );
  circularRaycast(mesh, 6.05);
  return mesh;
}
describe("Circular aperture selection", () => {
  it("never misses the exact centre at oblique transformed positions", () => {
    const mesh = disc(),
      caster = new T.Raycaster();
    for (let i = 0; i < 128; i++) {
      mesh.position.set(Math.sin(i) * 22, 8, -18);
      mesh.rotation.y = Math.sin(i) * 0.7;
      mesh.updateMatrixWorld(true);
      caster.set(
        new T.Vector3(0, 2.4, 16),
        mesh.position
          .clone()
          .sub(new T.Vector3(0, 2.4, 16))
          .normalize(),
      );
      const hits = caster.intersectObject(mesh);
      expect(hits).toHaveLength(1);
      expect(hits[0].point.distanceTo(mesh.position)).toBeLessThan(1e-10);
    }
  });
  it("rejects the invisible region outside the aperture and back side", () => {
    const mesh = disc();
    mesh.updateMatrixWorld();
    const caster = new T.Raycaster(
      new T.Vector3(6.1, 0, 10),
      new T.Vector3(0, 0, -1),
    );
    expect(caster.intersectObject(mesh)).toHaveLength(0);
    caster.set(new T.Vector3(0, 0, -10), new T.Vector3(0, 0, 1));
    expect(caster.intersectObject(mesh)).toHaveLength(0);
  });
  it("respects world-space near/far clipping and preserves the hit point", () => {
    const mesh = disc();
    mesh.scale.setScalar(2);
    mesh.updateMatrixWorld();
    const caster = new T.Raycaster(
      new T.Vector3(5, 0, 10),
      new T.Vector3(0, 0, -1),
      0,
      9,
    );
    expect(caster.intersectObject(mesh)).toHaveLength(0);
    caster.far = 11;
    const first = caster.intersectObject(mesh)[0];
    expect(first.distance).toBe(10);
    caster.set(new T.Vector3(1, 0, 10), new T.Vector3(0, 0, -1));
    caster.intersectObject(mesh);
    expect(first.point.x).toBe(5);
  });
});
