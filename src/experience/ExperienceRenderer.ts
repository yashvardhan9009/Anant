import * as T from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { assets } from "../engine/assets";
import { halfTimberHouse, WIND } from "../engine/architecture";
import { ContactAO } from "../engine/ContactAO";
import { GradeShader, GodRayShader } from "../engine/look";
import { dressEnvironment, disposeDressing } from "./EnvironmentDressing";
import { makeSkyDome } from "../engine/fx";
import { CameraRig } from "../engine/CameraRig";
import { QUALITY } from "../engine/quality";
import type { ScenePlan } from "../../shared/experience";
import { Phenomenon } from "./Phenomena";
import { Puddle } from "./Puddle";
import { createTerrain } from "./Terrain";
import { naturalFoliage, weatherStone } from "./NaturalMaterials";

export class ExperienceRenderer {
  readonly scene = new T.Scene();
  readonly camera = new T.PerspectiveCamera(58, 1, 0.08, 500);
  readonly rig = new CameraRig(this.camera);
  readonly renderer = new T.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  private composer = new EffectComposer(
    this.renderer,
    new T.WebGLRenderTarget(1, 1, {
      type: T.HalfFloatType,
      samples: QUALITY.msaa,
    }),
  );
  private grade = new ShaderPass(GradeShader);
  private rays = new ShaderPass(GodRayShader);
  private contactAO?: ContactAO;
  private hdrs = new Map<string, ReturnType<typeof assets.hdri>>();
  private bloom = new UnrealBloomPass(new T.Vector2(1, 1), 0.25, 0.5, 1.15);
  private sky = makeSkyDome(450);
  private content = new T.Group();
  private phenomena: Phenomenon[] = [];
  private puddle?: Puddle;
  private moving: { node: T.Object3D; y: number; mode: string }[] = [];
  private colliders: T.Box3[] = [];
  private sun = new T.DirectionalLight("#ffdbac", 3);
  private ambient = new T.HemisphereLight("#a7c7eb", "#454641", 1);
  private epoch = 0;
  private closed = false;
  private frame = 0;
  private last = performance.now();
  private time = 0;
  private skyTime = 0;
  private env?: T.WebGLRenderTarget;
  private weather?: T.Points;
  private weatherKind = "clear";
  private appearanceKey = "";
  private ownedTextures = new Set<T.Texture>();
  private resizeObserver: ResizeObserver;
  frozen = false;
  onFrame?: (position: T.Vector3, direction: T.Vector3, dt: number) => void;
  private terrainHeight = (_x: number, _z: number) => 0;
  private realm = {
    controlMode: "walk" as const,
    bounds: 100,
    eyeHeight: 1.72,
    groundY: (x: number, z: number) => this.terrainHeight(x, z),
    constrainWalk: (point: T.Vector3) => {
      for (const box of this.colliders) {
        if (
          point.x > box.min.x - 0.25 &&
          point.x < box.max.x + 0.25 &&
          point.z > box.min.z - 0.25 &&
          point.z < box.max.z + 0.25
        ) {
          const sides = [
            Math.abs(point.x - (box.min.x - 0.25)),
            Math.abs(point.x - (box.max.x + 0.25)),
            Math.abs(point.z - (box.min.z - 0.25)),
            Math.abs(point.z - (box.max.z + 0.25)),
          ];
          const side = sides.indexOf(Math.min(...sides));
          if (side < 2)
            point.x = side === 0 ? box.min.x - 0.25 : box.max.x + 0.25;
          else point.z = side === 2 ? box.min.z - 0.25 : box.max.z + 0.25;
        }
      }
      return point;
    },
  };

  constructor(private host: HTMLElement) {
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, QUALITY.name === "cinematic" ? 1.4 : 1),
    );
    this.renderer.toneMapping = T.AgXToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = QUALITY.shadows;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "Experience view. Drag to look, WASD to fly, E and Q for height, click to cast.",
    );
    host.append(canvas);
    this.rig.setFlight(new T.Vector3(0, 2.8, 12), 0, -0.03);
    this.sun.position.set(-30, 25, 15);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -35,
      right: 35,
      top: 35,
      bottom: -35,
      near: 1,
      far: 130,
    });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.content, this.sky.mesh, this.sun, this.ambient);
    for (const object of [this.sky.mesh, this.sun, this.ambient])
      object.layers.enable(1);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (QUALITY.ambientOcclusion) {
      this.contactAO = new ContactAO(this.scene, this.camera);
      this.contactAO.updateGtaoMaterial({
        radius: 1.2,
        thickness: 0.6,
        distanceFallOff: 1,
        samples: 8,
        screenSpaceRadius: false,
      });
      this.contactAO.updatePdMaterial({ radius: 3, samples: 8 });
      this.contactAO.blendIntensity = 0.42;
      this.composer.addPass(this.contactAO);
    }
    if (QUALITY.godRays) this.composer.addPass(this.rays);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grade);
    this.grade.uniforms.uVignette.value = 0.3;
    this.grade.uniforms.uGrain.value = 0.002;
    this.grade.uniforms.uContrast.value = 1.08;
    this.grade.uniforms.uSat.value = 0.96;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }
  private resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(
      w * this.renderer.getPixelRatio(),
      h * this.renderer.getPixelRatio(),
    );
  }
  async setPlan(plan: ScenePlan, resetCamera = false) {
    const key = JSON.stringify([plan.environment, plan.objects]);
    if (this.appearanceKey === key) {
      this.setEffects(plan.effects);
      if (resetCamera) this.rig.setFlight(new T.Vector3(0, 2.8, 12), 0, -0.03);
      return;
    }
    const generation = ++this.epoch;
    this.clear();
    this.scene.background = null;
    this.sky.mesh.visible = true;
    this.weatherKind = plan.environment.weather;
    if (resetCamera) this.rig.setFlight(new T.Vector3(0, 2.8, 12), 0, -0.03);
    const e = plan.environment,
      u = this.sky.uniforms,
      night = e.time === "night",
      blue = e.time === "blue";
    u.uTop.value.set(e.sky);
    u.uHorizon.value.set(
      e.time === "golden"
        ? "#e6bb81"
        : night
          ? "#202d4b"
          : blue
            ? "#263c55"
            : "#b1d3e7",
    );
    u.uBottom.value.set("#181c26");
    u.uSun.value = night ? 0.1 : blue ? 0.25 : 1;
    u.uStars.value = night ? 1 : blue ? 0.06 : 0;
    u.uNebula.value = 0;
    u.uAurora.value = e.aurora ? 1 : 0;
    u.uClouds.value = e.weather === "clear" ? 0.35 : 1;
    u.uSunDir.value.copy(this.sun.position).normalize();
    u.uSunColor.value.set(e.time === "golden" ? "#ffbd7a" : "#cadff7");
    u.uCloudDark.value.set("#8b99a6");
    this.sun.intensity = night ? 0.35 : blue ? 0.8 : 3.5;
    this.sun.color.set(
      e.time === "golden" ? "#ffca8d" : night ? "#8fa9e8" : "#f2f3e7",
    );
    this.ambient.intensity = night ? 0.18 : blue ? 0.28 : 0.45;
    this.scene.fog = new T.FogExp2(
      u.uHorizon.value,
      e.weather === "mist" ? 0.007 : 0.003,
    );
    this.renderer.toneMappingExposure = night ? 1.05 : 1;
    await assets.init();
    if (this.closed || generation !== this.epoch) return;
    const terrain = createTerrain(plan);
    this.terrainHeight = terrain.height;
    for (const texture of terrain.textures) this.ownedTextures.add(texture);
    this.content.add(terrain.group);
    void dressEnvironment(
      plan,
      () => !this.closed && generation === this.epoch,
      this.terrainHeight,
    ).then((group) => {
      if (this.closed || generation !== this.epoch) disposeDressing(group);
      else this.content.add(group);
    });
    for (const item of plan.objects) this.object(item, generation);
    this.setEffects(plan.effects);
    if (e.weather === "rain" || e.weather === "snow") {
      const n = 1200,
        points = new Float32Array(n * 3);
      for (let i = 0; i < points.length; i++)
        points[i] = Math.random() * 80 - 40;
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(points, 3));
      this.weather = new T.Points(
        g,
        new T.PointsMaterial({
          color: "#d2e5ee",
          size: e.weather === "rain" ? 0.045 : 0.12,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
      );
      this.content.add(this.weather);
    }
    // Capture the actual sky so glass, water and metal reflect the current atmosphere.
    const pmrem = new T.PMREMGenerator(this.renderer),
      envScene = new T.Scene();
    const envSky = this.sky.mesh.clone();
    envScene.add(envSky);
    const env = pmrem.fromScene(envScene, 0.06, 0.1, 500);
    pmrem.dispose();
    this.env?.dispose();
    this.env = env;
    this.scene.environment = env.texture;
    this.scene.background = null;
    this.sky.mesh.visible = true;
    const hdriId =
      e.time === "day"
        ? "kloofendal_48d_partly_cloudy_puresky"
        : "kloppenheim_06_puresky";
    if (!this.hdrs.has(hdriId)) this.hdrs.set(hdriId, assets.hdri(hdriId));
    void this.hdrs.get(hdriId)!.then((hdr) => {
      if (!hdr || this.closed || generation !== this.epoch) return;
      const capture = new T.PMREMGenerator(this.renderer),
        environment = capture.fromEquirectangular(hdr.texture);
      capture.dispose();
      this.env?.dispose();
      this.env = environment;
      this.scene.environment = environment.texture;
      this.scene.environmentIntensity = night ? 0.18 : blue ? 0.3 : 0.85;
      if (!e.aurora && e.time !== "night") {
        this.scene.background = hdr.texture;
        this.scene.backgroundIntensity = blue
          ? 0.09
          : e.time === "golden"
            ? 0.65
            : 0.85;
        this.sky.mesh.visible = false;
      }
      this.sun.position.copy(hdr.sunDir).multiplyScalar(70);
      this.sun.intensity = night ? 0.3 : blue ? 0.7 : 3.5;
      if (this.scene.fog instanceof T.FogExp2) {
        if (blue || night)
          this.scene.fog.color.set(blue ? "#21374e" : "#101c2d");
        else this.scene.fog.color.copy(hdr.horizon).multiplyScalar(0.5);
      }
    });
    this.appearanceKey = key;
  }
  private ownTextures(material: T.MeshStandardMaterial) {
    for (const t of [
      material.map,
      material.normalMap,
      material.roughnessMap,
      material.aoMap,
    ])
      if (t) this.ownedTextures.add(t);
  }
  private setEffects(effects: ScenePlan["effects"]) {
    for (const fx of this.phenomena) fx.dispose();
    this.phenomena = [];
    for (const spec of effects) {
      const fx = new Phenomenon(spec);
      this.phenomena.push(fx);
      this.content.add(fx.root);
      if (spec.kind !== "water" && spec.kind !== "ice")
        fx.root.traverse((o) => o.layers.enable(1));
    }
    const water = effects.find((e) => e.kind === "water");
    if (water && QUALITY.reflections) {
      if (!this.puddle) {
        this.puddle = new Puddle();
        this.content.add(this.puddle.mesh);
      }
      this.puddle.mesh.position.set(
        water.position[0],
        0.036,
        water.position[2],
      );
      this.puddle.mesh.scale.setScalar(Math.min(4, water.size * 2.3));
    } else {
      this.puddle?.dispose();
      this.puddle = undefined;
    }
  }
  launch(
    kind: ScenePlan["effects"][number]["kind"],
    point: [number, number, number],
  ) {
    const effect = [...this.phenomena]
      .reverse()
      .find(
        (f) =>
          f.spec.kind === kind &&
          f.spec.position.every((n, i) => Math.abs(n - point[i]) < 0.01),
      );
    if (effect) {
      const start = this.camera.position
        .clone()
        .addScaledVector(this.rig.forward, 1.1);
      start.y -= 0.65;
      effect.launch(start);
    }
  }
  private object(item: ScenePlan["objects"][number], generation: number) {
    const group = new T.Group();
    group.position.fromArray(item.position);
    group.rotation.y = T.MathUtils.degToRad(item.rotation ?? 0);
    group.scale.fromArray(item.scale);
    this.content.add(group);
    const material = new T.MeshPhysicalMaterial({
      color: item.color,
      roughness:
        item.material === "metal"
          ? 0.28
          : item.material === "glass"
            ? 0.12
            : 0.85,
      metalness: item.material === "metal" ? 0.85 : 0,
      transmission: item.material === "glass" ? 0.65 : 0,
      thickness: 1.2,
      emissive: item.material === "light" ? item.color : "#000000",
      emissiveIntensity: item.material === "light" ? 2 : 0,
    });
    if (item.material === "stone" || item.material === "wood") {
      assets.applyTo(
        material,
        item.material === "wood"
          ? "weathered_planks"
          : ["column", "arch", "basin"].includes(item.kind)
            ? "mossy_rock"
            : "stone_wall_04",
        2,
        0.7,
      );
      material.color.set(item.color);
      if (item.material === "stone") weatherStone(material);
    }
    this.ownTextures(material);
    const add = (geometry: T.BufferGeometry, x = 0, y = 0, z = 0) => {
      const mesh = new T.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      if (item.kind !== "tree" && item.kind !== "rock") mesh.layers.enable(1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    switch (item.kind) {
      case "column": {
        const shaft = new T.CylinderGeometry(0.35, 0.43, 2.55, 80, 16),
          p = shaft.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i),
            z = p.getZ(i),
            a = Math.atan2(z, x),
            r = Math.hypot(x, z);
          if (r > 0.05) {
            const flute = 1 - 0.045 * (0.5 + 0.5 * Math.cos(a * 20));
            p.setX(i, x * flute);
            p.setZ(i, z * flute);
          }
        }
        shaft.computeVertexNormals();
        add(shaft, 0, 1.55);
        add(new RoundedBoxGeometry(1, 0.18, 1, 2, 0.035), 0, 0.09);
        add(new T.CylinderGeometry(0.48, 0.48, 0.17, 48), 0, 0.265);
        add(new T.CylinderGeometry(0.48, 0.35, 0.18, 48), 0, 2.88);
        add(new RoundedBoxGeometry(1, 0.18, 1, 2, 0.025), 0, 3.06);
        break;
      }
      case "arch": {
        const parts: T.BufferGeometry[] = [];
        for (let i = 0; i < 15; i++) {
          const a = (i / 15) * Math.PI + 0.008,
            b = ((i + 1) / 15) * Math.PI - 0.008,
            s = new T.Shape();
          s.absarc(0, 1.5, 1, a, b, false);
          s.lineTo(Math.cos(b) * 0.65, 1.5 + Math.sin(b) * 0.65);
          s.absarc(0, 1.5, 0.65, b, a, true);
          s.closePath();
          const stone = new T.ExtrudeGeometry(s, {
            depth: 0.5,
            bevelEnabled: true,
            bevelSize: 0.009,
            bevelThickness: 0.009,
            bevelSegments: 1,
            curveSegments: 3,
          });
          stone.translate(0, 0, -0.25);
          parts.push(stone);
        }
        const ring = mergeGeometries(parts);
        if (ring) add(ring);
        parts.forEach((p) => p.dispose());
        for (const side of [-1, 1])
          for (let row = 0; row < 5; row++)
            add(
              new RoundedBoxGeometry(0.35, 0.292, 0.5, 1, 0.012),
              side * 0.825,
              0.15 + row * 0.3,
            );
        break;
      }
      case "house": {
        if (item.material !== "wood") {
          add(new RoundedBoxGeometry(4, 3, 3.5, 2, 0.035), 0, 1.5);
          const roofMaterial = new T.MeshStandardMaterial({
            color: "#97775c",
            roughness: 0.85,
          });
          assets.applyTo(roofMaterial, "clay_roof_tiles_02", 2, 0.8);
          this.ownTextures(roofMaterial);
          const shape = new T.Shape();
          shape.moveTo(-2.3, 0);
          shape.lineTo(0, 1.05);
          shape.lineTo(2.3, 0);
          shape.closePath();
          const roof = new T.Mesh(
            new T.ExtrudeGeometry(shape, { depth: 4.1, bevelEnabled: false }),
            roofMaterial,
          );
          roof.position.set(0, 3, -2.05);
          roof.castShadow = true;
          roof.receiveShadow = true;
          group.add(roof);
          const opening = new T.MeshStandardMaterial({
            color: "#16212a",
            roughness: 0.75,
          });
          const door = new T.Mesh(new T.PlaneGeometry(1.05, 2.15), opening);
          door.position.set(0, 1.08, 1.756);
          group.add(door);
          for (const x of [-1.35, 1.35]) {
            const window = new T.Mesh(new T.PlaneGeometry(0.65, 0.8), opening);
            window.position.set(x, 1.9, 1.757);
            group.add(window);
            add(
              new RoundedBoxGeometry(0.8, 0.12, 0.23, 1, 0.025),
              x,
              1.48,
              1.8,
            );
            add(new T.CylinderGeometry(0.13, 0.16, 2.8, 16), x, 1.4, 2.14);
          }
          add(new RoundedBoxGeometry(3.5, 0.25, 0.7, 1, 0.03), 0, 2.8, 2.12);
          add(new RoundedBoxGeometry(4.4, 0.16, 4.1, 1, 0.03), 0, 0.08, 0.16);
          break;
        }
        material.dispose();
        const house = halfTimberHouse({
          w: 4,
          d: 3.5,
          h: 3,
          roof: "#63534a",
          chimney: true,
        });
        house.traverse((o) => {
          if (o instanceof T.Mesh) {
            o.geometry = o.geometry.clone();
            o.material = Array.isArray(o.material)
              ? o.material.map((m) => m.clone())
              : o.material.clone();
          }
        });
        group.add(house);
        break;
      }
      case "tree":
      case "firepit":
      case "rock": {
        const fallback =
          item.kind === "tree"
            ? add(new T.ConeGeometry(1.3, 5, 12), 0, 2.5)
            : add(new T.DodecahedronGeometry(1, 1), 0, 0.8);
        if (item.kind === "tree") material.color.set("#365847");
        void assets
          .model(
            item.kind === "tree"
              ? ["island_tree_02", "tree_small_02", "island_tree_02"][
                  Math.abs(Math.round(item.position[0] + item.position[2])) % 3
                ]
              : item.kind === "firepit"
                ? "stone_fire_pit"
                : "boulder_01",
          )
          .then((gltf) => {
            if (!gltf || this.closed || generation !== this.epoch) return;
            const model = gltf.scene.clone(true);
            const bounds = new T.Box3().setFromObject(model),
              size = bounds.getSize(new T.Vector3()),
              center = bounds.getCenter(new T.Vector3());
            const s =
              (item.kind === "tree" ? 6 : item.kind === "firepit" ? 0.55 : 2) /
              Math.max(0.1, size.y);
            model.position.set(-center.x * s, -bounds.min.y * s, -center.z * s);
            model.scale.setScalar(s);
            model.traverse((o) => {
              if (o instanceof T.Mesh) {
                o.geometry = o.geometry.clone();
                o.material = Array.isArray(o.material)
                  ? o.material.map((m) => m.clone())
                  : o.material.clone();
                for (const mat of Array.isArray(o.material)
                  ? o.material
                  : [o.material]) {
                  if (mat instanceof T.MeshStandardMaterial) {
                    if (mat.map) mat.map.anisotropy = 8;
                    if (mat.alphaTest > 0 || mat.transparent) {
                      mat.side = T.DoubleSide;
                      mat.alphaTest = 0.18;
                      mat.alphaToCoverage = true;
                      mat.transparent = false;
                      mat.depthWrite = true;
                      naturalFoliage(mat, true);
                    }
                  }
                }
                if (item.kind === "firepit") o.layers.enable(1);
                o.castShadow = true;
                o.receiveShadow = true;
              }
            });
            fallback.removeFromParent();
            fallback.geometry.dispose();
            material.dispose();
            group.add(model);
          });
        break;
      }
      case "basin":
        add(new T.CylinderGeometry(1, 1, 0.18, 48), 0, 0.09);
        add(new T.CylinderGeometry(1, 1, 0.3, 48, 1, true), 0, 0.22);
        add(new T.TorusGeometry(0.97, 0.065, 12, 64), 0, 0.36).rotation.x =
          Math.PI / 2;
        break;
      case "pyramid":
        add(new T.ConeGeometry(1.4, 2, 4), 0, 1).rotation.y = Math.PI / 4;
        break;
      case "sphere":
        add(new T.SphereGeometry(1, 32, 24), 0, 1);
        break;
      case "dome":
        add(new T.SphereGeometry(1, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2));
        break;
      case "torus":
        add(new T.TorusGeometry(1, 0.16, 12, 64), 0, 1.2);
        break;
      case "crystal":
        add(new T.OctahedronGeometry(1, 0), 0, 1);
        break;
      default:
        add(new RoundedBoxGeometry(2, 2, 2, 2, 0.06), 0, 1);
    }
    if (item.motion !== "still")
      this.moving.push({ node: group, y: group.position.y, mode: item.motion });
    else if (["column", "house", "box", "pyramid"].includes(item.kind))
      this.colliders.push(new T.Box3().setFromObject(group));
  }
  hit(clientX: number, clientY: number): [number, number, number] {
    const r = this.renderer.domElement.getBoundingClientRect(),
      ray = new T.Raycaster();
    ray.setFromCamera(
      new T.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        1 - ((clientY - r.top) / r.height) * 2,
      ),
      this.camera,
    );
    // Aim at the visible phenomenon, not the ground many metres behind it.
    // This matters at eye height: the flame and the floor have different rays.
    let target: ScenePlan["effects"][number] | undefined;
    let nearest = 40;
    for (const fx of this.phenomena) {
      if (!["fire", "water", "ice", "steam"].includes(fx.spec.kind)) continue;
      const center = new T.Vector3().fromArray(fx.spec.position);
      center.y += fx.spec.size * 1.1;
      const hit = ray.ray.intersectSphere(
        new T.Sphere(center, fx.spec.size * 1.4),
        new T.Vector3(),
      );
      const distance = hit?.distanceTo(this.camera.position) ?? Infinity;
      if (distance < nearest) {
        nearest = distance;
        target = fx.spec;
      }
    }
    if (target) return [...target.position];
    const point = new T.Vector3();
    const ground = ray.ray.intersectPlane(
      new T.Plane(new T.Vector3(0, 1, 0), -0.08),
      point,
    );
    if (!ground || point.distanceTo(this.camera.position) > 40)
      ray.ray.at(9, point);
    else point.y = this.terrainHeight(point.x, point.z) + 0.08;
    point.y = Math.max(0.08, point.y);
    return point.toArray() as [number, number, number];
  }
  private tick = () => {
    if (this.closed) return;
    this.frame = requestAnimationFrame(this.tick);
    const now = performance.now(),
      dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (document.hidden) {
      this.rig.stopMotion();
      return;
    }
    this.rig.update(dt, this.realm);
    this.sky.mesh.position.copy(this.camera.position);
    this.skyTime += dt;
    this.sky.uniforms.uTime.value = this.skyTime;
    WIND.uTime.value = this.time;
    this.grade.uniforms.uTime.value = this.skyTime;
    this.puddle?.update(this.time);
    const projectedSun = this.sun.position
      .clone()
      .normalize()
      .multiplyScalar(200)
      .add(this.camera.position)
      .project(this.camera);
    this.rays.uniforms.uSun.value.set(
      projectedSun.x * 0.5 + 0.5,
      projectedSun.y * 0.5 + 0.5,
    );
    this.rays.uniforms.uStrength.value =
      projectedSun.z < 1 &&
      Math.abs(projectedSun.x) < 2 &&
      Math.abs(projectedSun.y) < 2
        ? 0.12
        : 0;
    if (!this.frozen) {
      this.time += dt;
      for (const fx of this.phenomena) fx.update(this.time, dt, this.camera);
      for (const m of this.moving) {
        if (m.mode === "float")
          m.node.position.y = m.y + Math.sin(this.time * 0.7) * 0.5;
        else m.node.rotation.y += dt * 0.2;
      }
      if (this.weather) {
        const p = this.weather.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          let y = p.getY(i) - dt * (this.weatherKind === "rain" ? 16 : 1.5);
          if (y < 0) y = 32;
          p.setY(i, y);
        }
        p.needsUpdate = true;
      }
    } else
      for (const fx of this.phenomena) fx.update(this.time, 0, this.camera);
    this.onFrame?.(this.camera.position, this.rig.forward, dt);
    this.composer.render();
  };
  private clear() {
    this.appearanceKey = "";
    this.rig.stopMotion();
    for (const f of this.phenomena) f.dispose();
    this.phenomena = [];
    this.puddle?.dispose();
    this.puddle = undefined;
    this.moving = [];
    this.colliders = [];
    this.weather = undefined;
    this.content.traverse((o) => {
      if (o instanceof T.Mesh || o instanceof T.Points) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          m.dispose();
      }
    });
    this.content.clear();
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedTextures.clear();
  }
  dispose() {
    this.closed = true;
    ++this.epoch;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.clear();
    this.env?.dispose();
    for (const hdr of this.hdrs.values())
      void hdr.then((h) => h?.texture.dispose());
    this.hdrs.clear();
    this.sky.mesh.geometry.dispose();
    this.sky.mesh.material.dispose();
    this.sun.shadow.dispose();
    this.bloom.dispose();
    this.composer.passes.forEach((p) => p.dispose());
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
