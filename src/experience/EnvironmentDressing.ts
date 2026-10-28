import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { assets, place } from "../engine/assets";
import { naturalFoliage, weatherStone } from "./NaturalMaterials";
import type { ScenePlan } from "../../shared/experience";

/** Deterministic environmental detail; the scene plan still controls the layout. */
export async function dressEnvironment(
  plan: ScenePlan,
  alive: () => boolean,
  heightAt: (x: number, z: number) => number = () => 0,
): Promise<T.Group> {
  const group = new T.Group();
  let seed = 74291;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const wooded =
    plan.environment.ground === "grass" ||
    plan.objects.filter((o) => o.kind === "tree").length >= 3;
  const instance = async (
    id: string,
    transforms: T.Matrix4[],
    foliage = false,
    height?: number,
    cards = false,
  ) => {
    if (!transforms.length) return;
    transforms = transforms.map((m) => {
      const t = m.clone();
      t.elements[13] += heightAt(t.elements[12], t.elements[14]);
      return t;
    });
    if (height) {
      const size = await assets.size(id);
      if (size)
        transforms = transforms.map((m) =>
          m
            .clone()
            .scale(new T.Vector3().setScalar(height / Math.max(0.01, size.y))),
        );
    }
    const loaded = cards
      ? await assets.impostors(id, transforms)
      : await assets.instanced(id, transforms, { shadows: !foliage });
    if (!loaded) return;
    // AssetLibrary retains its sources for other realms. Own render resources here.
    loaded.traverse((o) => {
      if (o instanceof T.Mesh) {
        o.geometry = o.geometry.clone();
        const mats = (
          Array.isArray(o.material) ? o.material : [o.material]
        ).map((m) => m.clone());
        for (const m of mats) {
          if (m instanceof T.MeshStandardMaterial) {
            if (m.transparent || m.alphaTest > 0) {
              m.transparent = false;
              m.alphaTest = 0.12;
              m.alphaToCoverage = true;
              m.side = T.DoubleSide;
            }
            if (foliage || cards) naturalFoliage(m, cards);
          }
        }
        o.material = Array.isArray(o.material) ? mats : mats[0];
      }
    });
    group.add(loaded);
  };
  if (wooded) {
    const trees: T.Matrix4[] = [],
      grass: T.Matrix4[] = [],
      ferns: T.Matrix4[] = [],
      rocks: T.Matrix4[] = [];
    for (let i = 0; i < 65; i++) {
      const angle = random() * Math.PI * 2,
        r = 32 + random() * 45;
      trees.push(
        place(
          Math.cos(angle) * r,
          0,
          Math.sin(angle) * r - 12,
          random() * 6.28,
          0.65 + random() * 0.65,
        ),
      );
    }
    for (let i = 0; i < 540; i++) {
      const side = i % 2 ? 1 : -1,
        x = side * (8.5 + Math.pow(random(), 1.6) * 32),
        z = random() * 85 - 55;
      if (Math.abs(x) < 8 && z > -45) continue;
      const s = 0.5 + random() * 1.2;
      grass.push(place(x, 0, z, random() * 6.28, s));
      if (i % 7 === 0)
        ferns.push(place(x, 0.01, z, random() * 6.28, 0.6 + random() * 0.6));
    }
    for (let i = 0; i < 40; i++) {
      const side = i % 2 ? -1 : 1,
        x = side * (9 + random() * 24),
        z = random() * 80 - 50;
      rocks.push(place(x, -0.16, z, random() * 6.28, 0.16 + random() * 0.5));
    }
    await instance(
      "tree_small_02",
      trees.filter((_, i) => i % 3 === 0),
      false,
      16,
      true,
    );
    if (!alive()) return group;
    await instance(
      "island_tree_02",
      trees.filter((_, i) => i % 3 === 1),
      false,
      18,
      true,
    );
    if (!alive()) return group;
    await instance(
      "tree_small_02",
      trees.filter((_, i) => i % 3 === 2),
      false,
      20,
      true,
    );
    if (!alive()) return group;
    await instance("grass_medium_01", grass, true, 0.6);
    if (!alive()) return group;
    await instance("fern_02", ferns, true, 0.9);
    if (!alive()) return group;
    await instance("rock_moss_set_01", rocks, false, 2);
  }
  if (plan.environment.ground === "stone") {
    const geometry = new RoundedBoxGeometry(1.15, 0.11, 1.5, 1, 0.035);
    const material = new T.MeshStandardMaterial({
      color: "#828b86",
      roughness: 0.64,
    });
    assets.applyTo(material, "worn_mossy_plasterwall", 1, 0.38);
    weatherStone(material);
    const matrices: T.Matrix4[] = [],
      colors: T.Color[] = [];
    for (let row = 0; row < 42; row++)
      for (let col = 0; col < 12; col++) {
        if ((col === 0 || col === 11) && random() < 0.35) continue;
        const x = (col - 5.5) * 1.18 + (row % 2) * 0.3,
          z = 16 - row * 1.55;
        matrices.push(
          place(x, -0.035 + random() * 0.018, z, (random() - 0.5) * 0.035),
        );
        colors.push(
          new T.Color().setHSL(
            0.11 + random() * 0.04,
            0.05,
            0.45 + random() * 0.22,
          ),
        );
      }
    const paving = new T.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, i) => {
      paving.setMatrixAt(i, m);
      paving.setColorAt(i, colors[i]);
    });
    paving.receiveShadow = true;
    paving.castShadow = true;
    group.add(paving);
  }
  return group;
}

export function disposeDressing(group: T.Group) {
  group.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        m.dispose();
    }
  });
  group.removeFromParent();
}
