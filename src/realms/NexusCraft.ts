import * as T from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { assets } from "../engine/assets";
import { QUALITY } from "../engine/quality";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { weatherStone } from "../experience/NaturalMaterials";

/** Static masonry is merged by material: mouldings add silhouette without a draw call each. */
export class Masonry {
  private parts = new Map<T.Material, T.BufferGeometry[]>();
  add(
    geometry: T.BufferGeometry,
    material: T.Material,
    position: number[] = [0, 0, 0],
    rotation: number[] = [0, 0, 0],
    scale: number[] = [1, 1, 1],
  ) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const key of Object.keys(g.attributes))
      if (!["position", "normal", "uv"].includes(key)) g.deleteAttribute(key);
    const matrix = new T.Matrix4().compose(
      new T.Vector3(...position),
      new T.Quaternion().setFromEuler(
        new T.Euler(...(rotation as [number, number, number])),
      ),
      new T.Vector3(...scale),
    );
    g.applyMatrix4(matrix);
    const list = this.parts.get(material) ?? [];
    list.push(g);
    this.parts.set(material, list);
  }
  box(
    size: number[],
    material: T.Material,
    position: number[],
    rotation: number[] = [0, 0, 0],
  ) {
    const bevel = Math.min(0.045, Math.min(...size) * 0.18);
    const g =
      bevel > 0.008
        ? new RoundedBoxGeometry(
            ...(size as [number, number, number]),
            1,
            bevel,
          )
        : new T.BoxGeometry(...(size as [number, number, number]));
    const uv = g.attributes.uv as T.BufferAttribute,
      n = g.attributes.normal as T.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const [a, b] =
        Math.abs(n.getX(i)) > 0.5
          ? [size[2], size[1]]
          : Math.abs(n.getY(i)) > 0.5
            ? [size[0], size[2]]
            : [size[0], size[1]];
      uv.setXY(i, uv.getX(i) * a * 0.42, uv.getY(i) * b * 0.42);
    }
    this.add(g, material, position, rotation);
    g.dispose();
  }
  finish(parent: T.Object3D, name = "Masonry") {
    for (const [material, parts] of this.parts) {
      const mesh = new T.Mesh(mergeGeometries(parts), material);
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      parts.forEach((g) => g.dispose());
    }
    this.parts.clear();
  }
}

export function nexusMaterials() {
  const stone = new T.MeshStandardMaterial({
    color: "#303943",
    roughness: 0.78,
  });
  const edge = new T.MeshStandardMaterial({
    color: "#59616b",
    roughness: 0.57,
    metalness: 0.25,
  });
  const bronze = new T.MeshStandardMaterial({
    color: "#a88753",
    metalness: 0.83,
    roughness: 0.3,
  });
  const iron = new T.MeshStandardMaterial({
    color: "#29313c",
    metalness: 0.86,
    roughness: 0.32,
  });
  const floor = new T.MeshPhysicalMaterial({
    color: "#151b25",
    roughness: 0.35,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.22,
  });
  const ready = assets.init().then(() => {
    assets.applyTo(stone, "castle_brick_01", 1, 0.65);
    stone.color.set("#343e4b");
    stone.roughness = 0.8;
    assets.applyTo(edge, "concrete_floor_02", 1, 0.4);
    edge.color.set("#4b5766");
    edge.roughness = 0.57;
    edge.metalness = 0.15;
    assets.applyTo(floor, "marble_01", 1, 0.16);
    floor.color.set("#111720");
    floor.roughness = 0.35;
    floor.metalness = 0;
    // Fine etched/scratched relief on metal, with colour and conductivity retained.
    assets.applyTo(iron, "granite_tile_02", 1, 0.12);
    iron.color.set("#3c4657");
    iron.metalness = 0.86;
    iron.roughness = 0.34;
  });
  weatherStone(stone);
  weatherStone(edge);
  return { stone, edge, bronze, iron, floor, ready };
}
export type NexusMaterials = ReturnType<typeof nexusMaterials>;

/** Original geometric inscriptions, packed into one texture shared by banners and stone bands. */
export function inscriptionTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 2048;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#060b13";
  c.fillRect(0, 0, 256, 2048);
  c.strokeStyle = "#b68e52";
  c.lineWidth = 3;
  c.strokeRect(16, 16, 224, 2016);
  c.strokeRect(24, 24, 208, 2000);
  for (let i = 0; i < 18; i++) {
    const y = 86 + i * 108,
      r = 27 + (i % 3) * 4;
    c.beginPath();
    c.arc(128, y, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(128, y - r - 13);
    c.lineTo(128, y + r + 13);
    c.moveTo(128 - r - 13, y);
    c.lineTo(128 + r + 13, y);
    c.moveTo(128, y - r);
    c.lineTo(128 + r, y);
    c.lineTo(128, y + r);
    c.lineTo(128 - r, y);
    c.closePath();
    c.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + i * 0.37;
      c.beginPath();
      c.moveTo(128 + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5);
      c.lineTo(
        128 + Math.cos(a + 0.5) * r * 1.35,
        y + Math.sin(a + 0.5) * r * 1.35,
      );
      c.stroke();
    }
  }
  const t = new T.CanvasTexture(canvas);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Wet stone reflects this scene. One bounded capture, rather than one per puddle/gate. */
export function wetFloor(radius: number) {
  const resolution = QUALITY.ultra ? 1536 : QUALITY.cinematic ? 768 : 384;
  const mirror = new Reflector(new T.CircleGeometry(radius, 128), {
    textureWidth: resolution,
    textureHeight: resolution,
    multisample: 0,
    clipBias: 0.004,
    shader: {
      name: "Nexus wet marble",
      uniforms: {
        tDiffuse: { value: null },
        textureMatrix: { value: new T.Matrix4() },
        color: { value: new T.Color("#ffffff") },
      },
      vertexShader: `uniform mat4 textureMatrix; varying vec4 vReflection; varying vec3 vWorld; varying vec2 vFloor;
        void main(){vFloor=position.xy;vWorld=(modelMatrix*vec4(position,1.)).xyz;vReflection=textureMatrix*vec4(position,1.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform sampler2D tDiffuse; varying vec4 vReflection; varying vec3 vWorld; varying vec2 vFloor;
        float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        void main(){vec4 uv=vReflection;vec2 scratch=vec2(sin(vFloor.x*29.+sin(vFloor.y*31.)),cos(vFloor.y*37.+vFloor.x*21.));uv.xy+=scratch*.00032*uv.w;
          vec3 reflected=texture2DProj(tDiffuse,uv).rgb;float facing=abs(normalize(cameraPosition-vWorld).y);
          float fresnel=.13+.68*pow(1.-facing,5.);float wetness=.62+.38*sin(vFloor.x*.39+sin(vFloor.y*.4))*sin(vFloor.y*.25);
          float joints=step(.018,fract(vFloor.x/2.4))*step(.018,fract(vFloor.y/2.4));
          gl_FragColor=vec4(reflected,clamp(fresnel*wetness*joints,.04,.82));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    },
  });
  mirror.name = "Wet marble planar reflection";
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.015;
  (mirror.material as T.ShaderMaterial).transparent = true;
  (mirror.material as T.ShaderMaterial).depthWrite = false;
  const capture = mirror.onBeforeRender;
  let last = -Infinity;
  mirror.onBeforeRender = (...args) => {
    const now = performance.now();
    if (now - last < 1000 / (QUALITY.ultra ? 24 : 12)) return;
    const renderer = args[0],
      auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try {
      capture.apply(mirror, args);
      last = now;
    } finally {
      renderer.shadowMap.autoUpdate = auto;
    }
  };
  return mirror;
}
