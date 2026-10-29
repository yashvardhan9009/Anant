import * as T from "three";

/** Analytic disc selection avoids numerical gaps at a triangle fan's centre. */
export function circularRaycast(mesh: T.Mesh, radius: number) {
  const inverse = new T.Matrix4(),
    ray = new T.Ray(),
    local = new T.Vector3();
  mesh.raycast = (caster, hits) => {
    inverse.copy(mesh.matrixWorld).invert();
    ray.copy(caster.ray).applyMatrix4(inverse);
    if (ray.direction.z >= -1e-9) return;
    const t = -ray.origin.z / ray.direction.z;
    if (t < 0) return;
    ray.at(t, local);
    if (local.x * local.x + local.y * local.y > radius * radius) return;
    const point = local.clone().applyMatrix4(mesh.matrixWorld),
      distance = caster.ray.origin.distanceTo(point);
    if (distance < caster.near || distance > caster.far) return;
    hits.push({ distance, point, object: mesh });
  };
}
