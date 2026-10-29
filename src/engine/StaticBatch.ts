import * as T from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Batch a self-contained static prop without merging its instanced/animated parts. */
export function batchStatic(root: T.Group) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const groups = new Map<string, { material: T.Material; meshes: T.Mesh[] }>();
  root.traverse((o) => {
    const mesh = o as T.Mesh;
    if (
      !mesh.isMesh ||
      (mesh as T.InstancedMesh).isInstancedMesh ||
      (mesh as T.SkinnedMesh).isSkinnedMesh ||
      Array.isArray(mesh.material) ||
      mesh.material.transparent ||
      (mesh.material as T.MeshStandardMaterial).vertexColors ||
      Object.keys(mesh.geometry.morphAttributes).length
    )
      return;
    const key =
        mesh.material.uuid + "-" + mesh.castShadow + "-" + mesh.receiveShadow,
      list = groups.get(key) ?? { material: mesh.material, meshes: [] };
    list.meshes.push(mesh);
    groups.set(key, list);
  });
  for (const { material, meshes } of groups.values()) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      const g = mesh.geometry.index
        ? mesh.geometry.toNonIndexed()
        : mesh.geometry.clone();
      for (const key of Object.keys(g.attributes))
        if (!["position", "normal", "uv"].includes(key)) g.deleteAttribute(key);
      if (!g.attributes.uv)
        g.setAttribute(
          "uv",
          new T.Float32BufferAttribute(
            new Float32Array(g.attributes.position.count * 2),
            2,
          ),
        );
      return g.applyMatrix4(
        new T.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld),
      );
    });
    const geometry = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    if (!geometry) continue;
    const merged = new T.Mesh(geometry, material);
    merged.name = "Batched building " + material.name;
    merged.castShadow = meshes[0].castShadow;
    merged.receiveShadow = meshes[0].receiveShadow;
    meshes.forEach((mesh) => {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    });
    root.add(merged);
  }
  return root;
}
