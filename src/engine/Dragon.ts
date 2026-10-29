import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Built } from "./objects";

let source: Promise<GLTF> | undefined;

/** Authored anatomy, skin weights and flight animation. Each creature owns its
 * skeleton/materials; textures are shared and the cached source is never edited. */
export function buildDragon(color: string): Built {
  const root = new THREE.Group();
  root.name = "Animated dragon";
  const tint: THREE.MeshStandardMaterial[] = [];
  let disposed = false,
    mixer: THREE.AnimationMixer | undefined;
  let model: THREE.Object3D | undefined;
  const ready = (source ??= new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync("/assets/creatures/dragon-flight.glb")
    .catch((error) => {
      source = undefined;
      throw error;
    }))
    .then((gltf) => {
      if (disposed) return;
      model = clone(gltf.scene);
      mixer = new THREE.AnimationMixer(model);
      const flight = gltf.animations.find((clip) => /fly/i.test(clip.name));
      if (flight) mixer.clipAction(flight).setEffectiveTimeScale(0.72).play();
      mixer.update(0);
      model.updateMatrixWorld(true);
      // Measure the actual animated pose. The source's rest-pose bounds are
      // about 13× smaller than its keyed flight pose and cannot set the scale.
      const bounds = new THREE.Box3().setFromObject(model, true);
      const size = bounds.getSize(new THREE.Vector3());
      const center=bounds.getCenter(new THREE.Vector3());
      const s = 9.5 / Math.max(size.x, size.z);
      // Normalize outside the animated hierarchy; imported clips may key the
      // model root's transforms and would overwrite changes made there.
      const normalization = new THREE.Group();
      normalization.scale.setScalar(s);
      normalization.position.set(-center.x*s,1.5-bounds.min.y*s,-center.z*s);
      normalization.add(model);
      const requested = new THREE.Color(color);
      // Preserve photographed colour variation and the pale ventral scales.
      // The default red is the authored skin; other colours tint it gently.
      const tintColor = requested
        .clone()
        .lerp(new THREE.Color("#ffffff"), 0.62);
      const materials = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      model.traverse((object) => {
        object.userData.objectId = root.userData.objectId;
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry = mesh.geometry.clone();
        mesh.castShadow = mesh.receiveShadow = true;
        const own = (original: THREE.Material) => {
          let material = materials.get(original);
          if (!material) {
            material = original.clone() as THREE.MeshStandardMaterial;
            material.color.multiply(tintColor);
            material.metalness = 0;
            material.roughness = 0.78;
            material.side = THREE.DoubleSide;
            material.alphaTest = 0.35;
            material.alphaToCoverage = true;
            material.transparent = false;
            if (material.map) material.map.anisotropy = 8;
            material.normalScale.set(0.65, 0.65);
            materials.set(original, material);
            tint.push(material);
          }
          return material;
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(own)
          : own(mesh.material);
        // Animated wings leave the rest-pose bounds, so stale mesh bounds must
        // not make them disappear near the edges of the image.
        mesh.frustumCulled = false;
      });
      root.add(normalization);
      root.userData.normalization = { size: size.toArray(), scale: s };
      root.userData.assetLoaded = true;
    })
    .catch((error) => {
      if (!disposed) {
        root.userData.assetError = String(error);
        console.warn("Dragon asset failed", error);
      }
    });
  return {
    root,
    tint,
    base: 0,
    ready,
    animate: (_t, dt) => {
      mixer?.update(Math.min(dt, 0.1));
    },
    dispose: () => {
      disposed = true;
      mixer?.stopAllAction();
      if (model) {
        mixer?.uncacheRoot(model);
        model.traverse((object) => {
          const skin = object as THREE.SkinnedMesh;
          if (skin.isSkinnedMesh) skin.skeleton.dispose();
        });
      }
    },
  };
}
