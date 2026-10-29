import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { Realm, InfoCard, FrameCtx } from "../engine/Realm";
import { makeSkyDome, makeMotes, Weather } from "../engine/fx";
import { QUALITY } from "../engine/quality";
import { WIND } from "../engine/architecture";
import { assets } from "../engine/assets";
import type { WorldState, Env } from "../../shared/worldState";
import { nexusArchitecture } from "./NexusArchitecture";
import { nexusMaterials } from "./NexusCraft";
import { NexusWindows } from "./NexusWindows";
import { NexusAtmosphere } from "./NexusAtmosphere";
import { nexusGroundHeight } from "./nexusLayout";
import { resolveObstacles } from "../engine/motion";

/** Monumental thresholds built in real 3D; the four destination controls are preserved. */
export class Nexus extends Realm {
  readonly id = "nexus" as const;
  private sky = makeSkyDome(1200);
  private motes = makeMotes(
    QUALITY.low ? 160 : 500,
    new THREE.Vector3(70, 35, 70),
    "#a9c6ef",
    0.025,
  );
  private amb = new THREE.HemisphereLight("#9ebce7", "#17141b", 0.4);
  private windows!: NexusWindows;
  private atmosphere!: NexusAtmosphere;
  private key!: THREE.DirectionalLight;
  private dynamicShadows = false;
  private shadowObjects?: WorldState["objects"];
  weather = new Weather();
  gates: THREE.Group[] = [];
  bounds = 34;
  arrivalPitch = 0.2;

  protected build() {
    this.look = {
      exposure: 1,
      bloom: [0.15, 0.36, 1.7],
      contrast: 1.01,
      saturation: 1,
      shadows: "#0c1420",
      highlights: "#f7e8d8",
      vignette: 0.16,
      godRays: 0,
    };
    this.scene.fog = new THREE.FogExp2("#080f20", 0.004);
    const u = this.sky.uniforms;
    u.uTop.value.set("#01030a");
    u.uHorizon.value.set("#081326");
    u.uBottom.value.set("#010204");
    u.uNebA.value.set("#182e58");
    u.uNebB.value.set("#24304c");
    u.uNebula.value = 0.06;
    u.uBand.value = 0.025;
    u.uStars.value = 0.85;
    this.envSource = this.sky.mesh;
    this.scene.add(this.sky.mesh, this.motes, this.weather.points, this.amb);
    const m = nexusMaterials();
    this.scene.add(nexusArchitecture(m));
    this.windows = new NexusWindows(this.scene, m);
    this.gates = this.windows.gates;
    this.atmosphere = new NexusAtmosphere(m);
    this.scene.add(this.atmosphere.group);

    // One shadow-casting key, then broad source-shaped fills. The emissive gates
    // contribute local light without four additional shadow-map renders.
    const key = new THREE.DirectionalLight("#bfd5ff", 1.65);
    this.key = key;
    key.position.set(-16, 32, 12);
    key.target.position.set(0, 3, -9);
    key.castShadow = QUALITY.shadows;
    key.shadow.autoUpdate = false;
    key.shadow.needsUpdate = true;
    key.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
    Object.assign(key.shadow.camera, {
      left: -39,
      right: 39,
      top: 39,
      bottom: -39,
      near: 1,
      far: 115,
    });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.00012;
    this.scene.add(key, key.target);
    RectAreaLightUniformsLib.init();
    const overhead = new THREE.RectAreaLight("#a8c8ff", 1.9, 24, 9);
    overhead.position.set(0, 23, -12);
    overhead.lookAt(0, 0, 1);
    this.scene.add(overhead);
    const warm = new THREE.RectAreaLight("#ffca88", 3, 10, 12);
    warm.position.set(23, 9, -3);
    warm.lookAt(0, 1, 9);
    this.scene.add(warm);
    const cool = new THREE.RectAreaLight("#79b8ff", 2.4, 10, 12);
    cool.position.set(-23, 9, -3);
    cool.lookAt(0, 1, 9);
    this.scene.add(cool);
    const center = new THREE.PointLight("#b6d1ff", 65, 15, 2);
    center.position.set(0, 5, 2);
    this.scene.add(center);
    void assets.init().then(async () => {
      const environment = await assets.hdri("kloppenheim_02_puresky");
      if (environment) {
        this.envTexture = environment.texture;
        this.envDirty = true;
        this.scene.environmentIntensity = 0.32;
      }
    });
  }

  groundY(x = 0, z = 0) {
    return nexusGroundHeight(x, z);
  }

  constrainWalk(position: THREE.Vector3) {
    const obstacles = [{ x: 0, z: -2, r: 0.7 }];
    for (const gate of this.gates)
      for (const side of [-1, 1]) {
        const p = gate.localToWorld(new THREE.Vector3(side * 7.6, 0, -0.4));
        obstacles.push({ x: p.x, z: p.z, r: 1.15 });
      }
    const safe = resolveObstacles(position.x, position.z, obstacles);
    position.x = safe.x;
    position.z = safe.z;
    return position;
  }

  protected applyEnv(e: Env) {
    const u = this.sky.uniforms;
    u.uTintAmt.value = e.skyColor ? 0.2 : 0;
    if (e.skyColor) u.uTint.value.set(e.skyColor);
    u.uAurora.value = e.weather === "aurora" ? 1 : 0;
    this.weather.set(e.weather);
    (this.scene.fog as THREE.FogExp2).density = 0.003 + e.fog * 0.012;
    this.amb.intensity =
      e.timeOfDay === "day" ? 0.3 : e.timeOfDay === "dawn" ? 0.26 : 0.2;
    this.envDirty = true;
  }

  update(ctx: FrameCtx) {
    super.update(ctx);
    // The hall and its shadow-casting scan are static. Reuse their shadow map
    // until user-created objects require dynamic shadows, including frozen poses.
    const moving =
      ctx.state.objects.some((o) => o.realm === "nexus") && !ctx.frozen;
    if (
      moving !== this.dynamicShadows ||
      ctx.state.objects !== this.shadowObjects
    ) {
      this.key.shadow.needsUpdate = true;
      this.dynamicShadows = moving;
      this.shadowObjects = ctx.state.objects;
    }
    this.key.shadow.autoUpdate = moving;
    if (ctx.frozen) return;
    this.sky.uniforms.uTime.value = ctx.t;
    this.sky.uniforms.uLightning.value = this.weather.lightning;
    (this.motes.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.t;
    WIND.uTime.value = ctx.t;
    this.windows.update(ctx.t);
    this.atmosphere.update(ctx.t);
    this.weather.update(
      ctx.dt,
      ctx.camera.position,
      this.env?.gravity ?? 1,
      ctx.t,
    );
  }

  info(s: WorldState): InfoCard {
    return {
      title: "The Nexus",
      mode: "THE THRESHOLD",
      subtitle:
        "The space between realities. Fly through the hall, choose a gate, or say where you want to go.",
      accuracy: [
        {
          tag: "ARTISTIC",
          text: "An imagined hall with 3D destination vignettes. Select a gate to open its interactive realm. The atom orbits, floating citadel, galaxy astrolabe and accretion image are artistic symbols; Heavy Gravity is hypothetical.",
        },
      ],
      stats: [
        {
          label: "Objects here",
          value: String(s.objects.filter((o) => o.realm === "nexus").length),
        },
        {
          label: "Open portals",
          value: String(s.portals.filter((p) => p.from === "nexus").length),
        },
        { label: "Gravity", value: `${s.env.nexus.gravity}×` },
      ],
    };
  }
}
