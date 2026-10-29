import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { assets } from "../engine/assets";

/** Actual rounded cobbles in the foreground, grouped into cullable 6 m cells. */
export function villageCobbles(height: (x: number, z: number) => number) {
  const root = new T.Group();
  root.name = "Physical village cobbles";
  const material = new T.MeshStandardMaterial({
    color: "#9a9484",
    roughness: 0.88,
  });
  assets.applyTo(material, "concrete_floor_02", 1, 0.22);
  material.color.set("#989285");
  const geometry = new RoundedBoxGeometry(0.224, 0.05, 0.285, 1, 0.021);
  material.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec2 cobbleOffset;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ncobbleOffset=fract(instanceMatrix[3].xz*vec2(.193,.271));');
    let f=shader.fragmentShader;for(const name of ['map_fragment','normal_fragment_maps','roughnessmap_fragment','aomap_fragment'] as const)f=f.replace('#include <'+name+'>',T.ShaderChunk[name]);
    for(const uv of ['vMapUv','vNormalMapUv','vRoughnessMapUv','vAoMapUv'])f=f.replaceAll(uv,'('+uv+'+cobbleOffset)');
    shader.fragmentShader='varying vec2 cobbleOffset;\n'+f;
  };material.customProgramCacheKey=()=> 'irregular-cobble-surface-v1';
  const cells = new Map<
    string,
    { x: number; z: number; points: [number, number][] }
  >();
  for (let row = -74; row <= 84; row++)
    for (let col = -31; col <= 31; col++) {
      const x = 2.5 + col * 0.24 + (row % 2) * 0.12,
        z = row * 0.3;
      if (
        !(Math.abs(x - 2.5) < 1.58 && z > -21 && z < 25) &&
        Math.hypot(x - 2.5, z - 2) > 7.05
      )
        continue;
      const cx = Math.floor(x / 6),
        cz = Math.floor(z / 6),
        key = cx + "," + cz,
        cell = cells.get(key) ?? { x: cx * 6 + 3, z: cz * 6 + 3, points: [] };
      cell.points.push([x, z]);
      cells.set(key, cell);
    }
  for (const cell of cells.values()) {
    const im = new T.InstancedMesh(geometry, material, cell.points.length),
      dummy = new T.Object3D(),
      color = new T.Color();
    cell.points.forEach(([x, z], i) => {
      const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453,
        r = n - Math.floor(n);
        dummy.position.set(x+(r-.5)*.015, height(x, z) + 0.012 + (r - 0.5) * 0.014, z+Math.sin(n)*.008);
        dummy.rotation.set((r - 0.5) * 0.06, (r - 0.5) * 0.13, (r - 0.5) * 0.06);
        dummy.scale.set(0.88 + r * 0.18, 0.85 + r * 0.25, 0.9 + r * 0.16);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      color.setScalar(0.78 + r * 0.35);
      im.setColorAt(i, color);
    });
    im.castShadow = im.receiveShadow = true;
    im.computeBoundingSphere();
    im.userData.cell = [cell.x, cell.z];
    root.add(im);
  }
  return root;
}
export function cullCobbles(root: T.Group, camera: T.Vector3) {
  for (const mesh of root.children) {
    const [x, z] = mesh.userData.cell;
    mesh.visible = Math.hypot(camera.x - x, camera.z - z) < 27;
  }
}
