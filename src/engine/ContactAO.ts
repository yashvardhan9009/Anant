import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import type * as THREE from 'three';

/** Half-resolution contact shading for architecture. Exclude sky, glass and VFX. */
export class ContactAO extends GTAOPass {
  private hidden = new Map<THREE.Object3D, boolean>();

  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
  }

  overrideVisibility() {
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      // Aperture scenery uses camera-dependent clipping that the normal/depth
      // override material cannot reproduce. Do not cast an unclipped AO silhouette.
      if (object.userData.skipContactAO || (object as THREE.Points).isPoints || (object as THREE.Line).isLine || (object as THREE.Sprite).isSprite ||
          materials.some(m => m.transparent || m.alphaTest > 0 || (m as THREE.MeshPhysicalMaterial).transmission > 0 || (m as THREE.ShaderMaterial).isShaderMaterial || m.side === 1)) {
        this.hidden.set(object, object.visible);
        object.visible = false;
      }
    });
  }

  restoreVisibility() {
    for (const [object, visible] of this.hidden) object.visible = visible;
    this.hidden.clear();
  }
}
