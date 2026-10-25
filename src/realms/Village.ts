import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Realm, InfoCard, FrameCtx } from '../engine/Realm';
import { makeSkyDome, makeMotes, Weather, NOISE_GLSL } from '../engine/fx';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { halfTimberHouse, worldBox, M, barrel, crate, grassField, forest, rocks, Ridges, groundMaterial, WIND, addWind } from '../engine/architecture';
import { softSprite, cloth, applyPBR } from '../engine/textures';
import { QUALITY } from '../engine/quality';
import { assets, place } from '../engine/assets';
import type { WorldState, Env } from '../../shared/worldState';
import { NPCS, NpcDef, FACTS, StoryState } from '../../shared/story';

/** radius inside which trees use scanned models */
const NEAR_TREES = QUALITY.low ? 38 : 50;

const WAYPOINTS: Record<string, [number, number]> = {
  gate: [3, 19], square: [2.5, 2], watchtower: [-16, -15], inn: [10, 1], forge: [-9, -3], garden: [13.5, 10], well: [-11, 9.5],
};

/** Smooth value-noise heightfield, identical on CPU (ground queries) and for the mesh. */
function h2(x: number, z: number) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = h2(xi, zi), b = h2(xi + 1, zi), c = h2(xi, zi + 1), d = h2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function terrainHeight(x: number, z: number) {
  const r = Math.hypot(x, z);
  let h = (vnoise(x * 0.05, z * 0.05) - 0.5) * 1.6 + (vnoise(x * 0.13, z * 0.13) - 0.5) * 0.5;
  h *= THREE.MathUtils.smoothstep(r, 20, 40) * 0.8 + 0.2;
  h += Math.pow(THREE.MathUtils.smoothstep(r, 45, 100), 1.5) * 26 * (0.6 + vnoise(x * 0.03 + 9, z * 0.03) * 0.8);
  return h;
}

interface NpcView {
  def: NpcDef;
  root: THREE.Group;
  body: THREE.Group;
  label: CSS2DObject;
  target: THREE.Vector3;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  ring: THREE.Mesh;
  walking: boolean;
  phase: number;
  approachPlayer: boolean;
}

export class Village extends Realm {
  readonly id = 'village' as const;
  eyeHeight = 1.75;
  bounds = 44;
  private sky = makeSkyDome();
  private sun = new THREE.DirectionalLight('#ffb27a', 2.4);
  private hemi = new THREE.HemisphereLight('#6a8ad0', '#2a2018', 0.5);
  private lanternLights: THREE.PointLight[] = [];
  private forgeLight = new THREE.PointLight('#ff6a1a', 30, 16, 2);
  private fireflies = makeMotes(320, new THREE.Vector3(80, 5, 80), '#e4ff8a', 0.07);
  private embers = makeMotes(160, new THREE.Vector3(1.2, 5, 1.2), '#ff8a3a', 0.07);
  private hollowMat!: THREE.ShaderMaterial;
  weather = new Weather();
  npcs = new Map<string, NpcView>();
  private crown!: THREE.Group;
  private moonleaf!: THREE.InstancedMesh;
  talkingTo?: string;
  private story?: StoryState;
  greeted = false;
  /** fired when an NPC that walked up to the player arrives (opening line) */
  onApproach?: (npcId: string) => void;

  protected build() {
    const q = QUALITY;
    this.look = { exposure: 1.1, bloom: [0.42, 0.55, 0.86], contrast: 1.16, saturation: 0.95, shadows: '#0a2030', highlights: '#ffcf9a', vignette: 0.6, godRays: 0.6 };
    this.scene.fog = new THREE.FogExp2('#5a3e4a', 0.012);
    this.sky.uniforms.uClouds.value = 0.9;
    this.envSource = this.sky.mesh;
    this.scene.add(this.sky.mesh, this.hemi, this.fireflies, this.weather.points, this.ridges.group);
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 220 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    // Terrain: vertex-coloured biome blend × tiled PBR detail
    const size = 300, seg = 200;
    const tg = new THREE.PlaneGeometry(size, size, seg, seg);
    tg.rotateX(-Math.PI / 2);
    const pos = tg.attributes.position as THREE.BufferAttribute;
    const cols = new Float32Array(pos.count * 3);
    const grass = new THREE.Color('#4f6a34'), grass2 = new THREE.Color('#6b7a3a'), dirt = new THREE.Color('#7a6248'), rockC = new THREE.Color('#6a6560'), snow = new THREE.Color('#e4e8f4');
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = terrainHeight(x, z);
      pos.setY(i, y);
      c.copy(grass).lerp(grass2, vnoise(x * 0.08, z * 0.08));
      c.lerp(dirt, THREE.MathUtils.clamp(this.pathFactor(x, z), 0, 1) * 0.85);
      if (y > 5) c.lerp(rockC, THREE.MathUtils.smoothstep(y, 5, 11));
      if (y > 17) c.lerp(snow, THREE.MathUtils.smoothstep(y, 17, 23));
      cols.set([c.r, c.g, c.b], i * 3);
    }
    tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    tg.computeVertexNormals();
    const ground = new THREE.Mesh(tg, groundMaterial());
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Cobbled square and road, conformed to the terrain
    const conform = (g: THREE.BufferGeometry, lift = 0.05) => {
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setY(i, this.groundY(p.getX(i), p.getZ(i)) + lift);
      g.computeVertexNormals();
      return g;
    };
    const sq = new THREE.CircleGeometry(7.2, 64, 0, Math.PI * 2);
    sq.rotateX(-Math.PI / 2).translate(2.5, 0, 2);
    const sqUv = sq.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < sqUv.count; i++) sqUv.setXY(i, sqUv.getX(i) * 2.5, sqUv.getY(i) * 2.5);
    const square = new THREE.Mesh(conform(sq), M.cobble());
    square.receiveShadow = true;
    this.scene.add(square);
    const road = new THREE.PlaneGeometry(3.2, 46, 4, 80);
    road.rotateX(-Math.PI / 2).translate(2.5, 0, 2);
    const rUv = road.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < rUv.count; i++) rUv.setXY(i, rUv.getX(i) * 1.1, rUv.getY(i) * 16);
    const roadM = new THREE.Mesh(conform(road, 0.04), M.cobble());
    roadM.receiveShadow = true;
    this.scene.add(roadM);

    // Buildings — half-timbered, facing the square
    const face = (x: number, z: number, j = 0) => Math.atan2(2.5 - x, 2 - z) + j;
    const place = (g: THREE.Group, x: number, z: number, rot: number, smoke = true) => {
      g.position.set(x, this.groundY(x, z) - 0.15, z);
      g.rotation.y = rot;
      this.scene.add(g);
      this.footprints.push({ x, z, r: 4.2 });
      if (smoke && g.userData.chimneyTop) {
        const top = (g.userData.chimneyTop as THREE.Vector3).clone().applyEuler(g.rotation).add(g.position);
        this.smokeAt(top);
      }
      return g;
    };
    place(halfTimberHouse({ w: 7, d: 5, h: 5.4, floors: 2, jetty: true, roof: '#4a2a28' }), 12.5, -3, face(12.5, -3)); // the Lantern & Thistle inn
    place(halfTimberHouse({ w: 4.8, d: 4.2, h: 3, roof: '#3a3436' }), -11.5, -6.5, face(-11.5, -6.5)); // forge
    place(halfTimberHouse({ w: 4.2, d: 3.6, h: 2.8, roof: '#3a4a34' }), 15.5, 14, face(15.5, 14)); // Seren's cottage
    const ring: [number, number, number, 1 | 2, string][] = [
      [-6, -14, 3.2, 2, '#5a3028'], [6.5, -14, 2.8, 1, '#4a3a3a'], [-15.5, 4, 3, 1, '#5a3028'], [-4, 15, 2.8, 2, '#3e3036'],
      [8.5, 16, 3, 1, '#5a3028'], [20, 1, 3, 2, '#4a2a28'], [-21, -6, 2.8, 1, '#3e3036'], [19, -12.5, 3.2, 2, '#5a3028'], [-9, 21, 3, 1, '#4a3a3a'], [21.5, 8, 2.8, 1, '#3a4a34'],
    ];
    ring.forEach(([x, z, h, fl, roof], i) => place(halfTimberHouse({ w: 4.2 + (i % 3) * 0.7, d: 3.8 + (i % 2) * 0.6, h: h * fl * 0.95, floors: fl, jetty: fl === 2, roof }), x, z, face(x, z, ((i * 37) % 7 - 3) * 0.04), i % 2 === 0));

    // Inn sign + barrels/crates for life
    const sign = new THREE.Mesh(worldBox(1.4, 0.7, 0.08, 1), M.timber());
    sign.position.set(9.2, this.groundY(9.2, 0) + 2.9, 0.4);
    sign.castShadow = true;
    this.scene.add(sign);
    for (const [x, z, k] of this.propSpots) {
      const o = k ? crate(0.7) : barrel();
      o.position.set(x, this.groundY(x, z), z);
      o.rotation.y = x * 3;
      this.scene.add(o);
      this.procProps.push(o);
    }

    // Forge fire
    this.forgeLight.position.set(-8.5, this.groundY(-8.5, -3.5) + 1.2, -3.5);
    this.forgeLight.castShadow = false;
    this.scene.add(this.forgeLight);
    const hearth = new THREE.Mesh(worldBox(1.4, 0.8, 1.1, 0.6), M.stone());
    hearth.position.set(-8.5, this.groundY(-8.5, -3.5) + 0.4, -3.5);
    const coals = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.8), new THREE.MeshStandardMaterial({ color: '#1a0a05', emissive: '#ff4a10', emissiveIntensity: 4 }));
    coals.position.copy(hearth.position).setY(hearth.position.y + 0.42);
    this.embers.position.copy(coals.position);
    this.scene.add(hearth, coals, this.embers);
    const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.45, 0.35), M.iron());
    anvil.position.set(-7, this.groundY(-7, -2) + 0.55, -2);
    anvil.castShadow = true;
    const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.35, 10), M.timber());
    stump.position.set(-7, this.groundY(-7, -2) + 0.17, -2);
    this.scene.add(anvil, stump);

    // Shrine (north): weathered stone arch over an empty pedestal — the crown is gone
    const shrine = new THREE.Group();
    shrine.position.set(2.5, this.groundY(2.5, -20), -20);
    for (let i = 0; i < 3; i++) shrine.add(this.box(worldBox(7 - i * 1.2, 0.3, 4.5 - i * 0.8, 0.5), M.stone(), 0, 0.15 + i * 0.3, 0));
    for (const sx of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.48, 5, 14), M.stone());
      col.position.set(sx * 2.2, 3.4, 0);
      col.castShadow = true;
      shrine.add(col);
      shrine.add(this.box(worldBox(1.2, 0.35, 1.2, 0.5), M.stone(), sx * 2.2, 1.05, 0));
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.38, 12, 40, Math.PI), M.stone());
    arch.position.y = 5.9;
    arch.castShadow = true;
    shrine.add(arch);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 1.3, 16), M.stone());
    ped.position.y = 1.55;
    ped.castShadow = true;
    shrine.add(ped);
    this.crown = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: '#ffcf5a', emissive: '#ff9a1a', emissiveIntensity: 0.6, metalness: 1, roughness: 0.22 });
    this.crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.36, 0.25, 32, 1, true), gold));
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.32, 8), gold);
      sp.position.set(Math.cos((i / 8) * 6.283) * 0.38, 0.27, Math.sin((i / 8) * 6.283) * 0.38);
      this.crown.add(sp);
    }
    this.crown.position.y = 2.45;
    this.crown.visible = false;
    shrine.add(this.crown);
    const shrineGlow = new THREE.PointLight('#8a6bff', 4, 10, 2);
    shrineGlow.position.y = 3;
    shrine.add(shrineGlow);
    this.scene.add(shrine);

    // Old well
    const well = new THREE.Group();
    well.position.set(-12.5, this.groundY(-12.5, 11), 11);
    const ringG = new THREE.CylinderGeometry(1.15, 1.25, 1, 20, 1, true);
    const ruv = ringG.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * 2.5, ruv.getY(i) * 0.5);
    const wr = new THREE.Mesh(ringG, M.stone());
    wr.position.y = 0.5;
    wr.castShadow = true;
    (wr.material as THREE.Material).side = THREE.DoubleSide;
    well.add(wr, this.box(new THREE.CylinderGeometry(1.1, 1.1, 0.05, 20), new THREE.MeshStandardMaterial({ color: '#05070a', roughness: 0.05, metalness: 0.2 }), 0, 0.6, 0));
    for (const sx of [-1, 1]) well.add(this.box(worldBox(0.16, 2.4, 0.16, 1), M.timber(), sx * 1.05, 1.2, 0));
    const wroof = halfRoof(2.8, 1.8, 0.8);
    wroof.position.y = 2.4;
    well.add(wroof);
    this.scene.add(well);
    this.footprints.push({ x: -12.5, z: 11, r: 2 });

    // Watchtower
    const wt = new THREE.Group();
    wt.position.set(-19, this.groundY(-19, -18), -18);
    for (const [x, z] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      const leg = this.box(worldBox(0.28, 9, 0.28, 0.8), M.timber(), x, 4.5, z);
      leg.rotation.set(z * 0.02, 0, -x * 0.02);
      wt.add(leg);
    }
    for (const y of [2.5, 5.5]) for (const r of [0, Math.PI / 2]) {
      const br = this.box(worldBox(3.2, 0.14, 0.14, 0.8), M.timber(), 0, y, 0);
      br.rotation.y = r;
      wt.add(br);
    }
    wt.add(this.box(worldBox(3.4, 0.25, 3.4, 0.6), M.timber(), 0, 9, 0));
    const tRoof = halfRoof(4, 4, 1.8);
    tRoof.position.y = 11.2;
    wt.add(tRoof);
    const beacon = new THREE.PointLight('#ffaa55', 10, 26, 2);
    beacon.position.y = 9.8;
    wt.add(beacon);
    this.scene.add(wt);
    this.footprints.push({ x: -19, z: -18, r: 2.5 });

    // Seren's walled garden with glowing moonleaf
    this.moonleaf = new THREE.InstancedMesh(new THREE.ConeGeometry(0.09, 0.45, 6), new THREE.MeshStandardMaterial({ color: '#6affe0', emissive: '#2affd0', emissiveIntensity: 1.8, roughness: 0.4 }), 60);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) {
      const x = 11 + (i % 10) * 0.55 + Math.sin(i * 7) * 0.15, z = 15.2 + Math.floor(i / 10) * 0.55;
      m4.compose(new THREE.Vector3(x, this.groundY(x, z) + 0.22, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(i) * 0.3, 0, Math.cos(i) * 0.3)), new THREE.Vector3(1, 0.8 + (i % 3) * 0.2, 1));
      this.moonleaf.setMatrixAt(i, m4);
    }
    this.scene.add(this.moonleaf);
    const gardenLight = new THREE.PointLight('#40ffd8', 3, 7, 2);
    gardenLight.position.set(13.5, this.groundY(13.5, 16.5) + 0.8, 16.5);
    this.scene.add(gardenLight);
    for (const [x, z, w, d] of [[13.4, 14, 6.4, 0.35], [13.4, 19, 6.4, 0.35], [10.3, 16.5, 0.35, 5.2]] as [number, number, number, number][]) {
      this.scene.add(this.box(worldBox(w, 1, d, 0.6), M.stone(), x, this.groundY(x, z) + 0.45, z));
    }
    this.footprints.push({ x: 13.5, z: 16.5, r: 3.5 });

    // Lanterns
    const lanternSpots: [number, number][] = [[5, 8], [0, -4], [7.5, 2], [-3, 2], [5, 16], [0, -12], [-8, 6], [12, 6]];
    lanternSpots.forEach(([x, z], i) => {
      const y = this.groundY(x, z);
      this.scene.add(this.box(new THREE.CylinderGeometry(0.06, 0.09, 2.8, 8), M.iron(), x, y + 1.4, z));
      this.scene.add(this.box(new THREE.BoxGeometry(0.34, 0.46, 0.34), new THREE.MeshStandardMaterial({ color: '#ffb347', emissive: '#ffa040', emissiveIntensity: 5 }), x, y + 2.95, z, false));
      this.scene.add(this.box(new THREE.ConeGeometry(0.3, 0.28, 4).rotateY(Math.PI / 4), M.iron(), x, y + 3.3, z));
      if (i < 6) {
        const l = new THREE.PointLight('#ffae5a', 8, 14, 2);
        l.position.set(x, y + 2.95, z);
        this.lanternLights.push(l);
        this.scene.add(l);
      }
      this.footprints.push({ x, z, r: 0.5 });
    });

    // Fences along the southern road
    const rails: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) for (let z = 9; z < 24; z += 2.2) {
      const x = 2.5 + side * 2.4;
      const y = this.groundY(x, z);
      const post = worldBox(0.14, 1.1, 0.14, 1);
      post.translate(x, y + 0.55, z);
      rails.push(post);
      const rail = worldBox(0.07, 0.08, 2.2, 1);
      rail.translate(x, y + 0.85, z + 1.1);
      rails.push(rail);
      const rail2 = rail.clone().translate(0, -0.35, 0);
      rails.push(rail2);
    }
    const fence = new THREE.Mesh(mergeGeometries(rails), M.timber());
    fence.castShadow = true;
    this.scene.add(fence);

    // Grass, forest, rocks
    const clear = (x: number, z: number) => this.pathFactor(x, z) < 0.15 && !this.footprints.some((f) => (x - f.x) ** 2 + (z - f.z) ** 2 < f.r * f.r) && (x - 2.5) ** 2 + (z - 2) ** 2 > 7.6 ** 2;
    this.scene.add(grassField(q.grassBlades, () => {
      const r = Math.sqrt(Math.random()) * 46, a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = this.groundY(x, z);
      return clear(x, z) && y < 6 ? { x, y, z } : null;
    }));
    const spots: { x: number; y: number; z: number; s: number; rot: number; kind: 'pine' | 'oak' }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 420; i++) {
      const a = rnd() * Math.PI * 2, r = 30 + Math.pow(rnd(), 0.7) * 70;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x - 2.5) < 5 && z > 20) continue;
      const y = this.groundY(x, z);
      if (y > 16) continue;
      spots.push({ x, y: y - 0.2, z, s: 0.9 + rnd() * 0.8, rot: rnd() * 6.28, kind: rnd() < 0.68 ? 'pine' : 'oak' });
    }
    for (const [x, z] of [[-14, -12], [9, 9.5], [-2, -9], [17, -6], [-17, 12], [24, 14], [-24, 2]]) spots.push({ x, y: this.groundY(x, z) - 0.1, z, s: 0.85, rot: x, kind: 'oak' });
    this.treeSpots = spots;
    this.forestGroup = forest(spots);
    this.scene.add(this.forestGroup);
    const rs: { x: number; y: number; z: number; s: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2, r = 18 + rnd() * 60;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!clear(x, z)) continue;
      rs.push({ x, y: this.groundY(x, z), z, s: 0.3 + rnd() * (r > 40 ? 2.5 : 0.8) });
    }
    this.rockSpots = rs;
    this.rockGroup = rocks(rs);
    this.scene.add(this.rockGroup);

    // The Hollow: creeping dark mist at the edge of the world
    this.hollowMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0.5 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vW = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vW,1.0); }`,
      fragmentShader: `uniform float uTime, uStrength; varying vec2 vUv; varying vec3 vW; ${NOISE_GLSL}
        void main(){ float n = fbm(vec3(vW.x*0.05, vW.y*0.08 - uTime*0.08, vW.z*0.05 + uTime*0.04));
          float a = smoothstep(1.0, 0.0, vUv.y) * smoothstep(0.0, 0.15, vUv.y) * (0.25 + n*0.7) * uStrength;
          gl_FragColor = vec4(mix(vec3(0.04,0.0,0.07), vec3(0.22,0.06,0.3), n), a); }`,
    });
    const hollow = new THREE.Mesh(new THREE.CylinderGeometry(62, 62, 22, 96, 1, true), this.hollowMat);
    hollow.position.y = 6;
    this.scene.add(hollow);

    for (const def of NPCS) this.addNpc(def);
    this.terrain = ground;
    this.upgradeWithAssets();
  }

  private footprints: { x: number; z: number; r: number }[] = [];
  private propSpots: [number, number, number][] = [[9, 1.5, 0], [9.6, 2.2, 0], [-8.6, -3.6, 1], [-9.4, -2.8, 0], [-7.8, -4.6, 1], [14.5, 1, 1]];
  private procProps: THREE.Object3D[] = [];
  private treeSpots: { x: number; y: number; z: number; s: number; rot: number; kind: 'pine' | 'oak' }[] = [];
  private rockSpots: { x: number; y: number; z: number; s: number }[] = [];
  private forestGroup?: THREE.Object3D;
  private rockGroup?: THREE.Object3D;
  private terrain?: THREE.Mesh;
  private hdr?: { texture: THREE.DataTexture; sunDir: THREE.Vector3; horizon: THREE.Color; zenith: THREE.Color };
  /** which real assets were loaded (shown in the reality card) */
  assetReport: string[] = [];

  /**
   * Replace procedural stand-ins with scanned CC0 assets (Poly Haven) where available.
   * Runs after the procedural build, so the village is always usable even offline.
   */
  private async upgradeWithAssets() {
    await assets.init();
    const rep: string[] = [];
    // 1 — scanned surfaces, applied in place to the shared materials
    const surf: [THREE.MeshStandardMaterial, string, number][] = [
      [M.stone(), 'stone_wall_04', 1], [M.plaster(), 'plastered_wall_02', 1], [M.timber(), 'weathered_planks', 1],
      [M.cobble(), 'cobblestone_floor_01', 3], [M.rock(), 'mossy_rock', 1],
      [M.roof('#4a2a28'), 'clay_roof_tiles_02', 2.5], [M.roof('#5a3028'), 'clay_roof_tiles_02', 2.5], [M.roof('#6a3b2c'), 'clay_roof_tiles_02', 2.5],
      [M.roof('#3e3036'), 'roof_slates_02', 2.5], [M.roof('#4a3a3a'), 'roof_slates_02', 2.5], [M.roof('#3a3436'), 'roof_slates_02', 2.5], [M.roof('#3a2c2c'), 'roof_slates_02', 2],
      [M.roof('#3a4a34'), 'thatch_roof_angled', 2],
    ];
    let n = 0;
    for (const [m, id, rep2] of surf) if (assets.applyTo(m, id, rep2, 1.2)) n++;
    // scans are neutral-white; weather them to sit in the scene
    M.plaster().color.set('#c9b9a0');
    M.stone().color.set('#b8ae9f');
    M.timber().color.set('#a08a74');
    if (this.terrain && assets.applyTo(this.terrain.material as THREE.MeshStandardMaterial, 'leafy_grass', 70, 1)) {
      // vertex colours become gentle tints over the scanned ground
      const col = this.terrain.geometry.attributes.color as THREE.BufferAttribute;
      const pos = this.terrain.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < col.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const p = THREE.MathUtils.clamp(this.pathFactor(x, z), 0, 1);
        const c = new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.62, 0.5, 0.38), p * 0.9).multiplyScalar(0.85 + vnoise(x * 0.07, z * 0.07) * 0.3);
        if (y > 5) c.lerp(new THREE.Color(0.55, 0.53, 0.5), THREE.MathUtils.smoothstep(y, 5, 11));
        if (y > 17) c.lerp(new THREE.Color(1.6, 1.65, 1.75), THREE.MathUtils.smoothstep(y, 17, 23));
        col.setXYZ(i, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
      n++;
    }
    if (n) rep.push(`${n} scanned PBR surfaces`);

    // 2 — real dusk sky (HDRI) lighting the whole scene
    this.hdr = (await assets.hdri('kloppenheim_06_puresky')) ?? undefined;
    if (this.hdr) {
      rep.push('HDRI sky: Kloppenheim 06 (dusk)');
      if (this.env) this.applyEnv(this.env);
    }

    const foliage = (mode: 'tree' | 'plant') => (m: THREE.MeshStandardMaterial) => {
      if (m.alphaTest > 0 || m.transparent) { m.side = THREE.DoubleSide; m.alphaTest = Math.max(m.alphaTest, 0.45); m.transparent = false; }
      addWind(m, mode);
    };
    // 3 — real trees replace the procedural forest
    const conifers = ['fir_tree_01', 'pine_tree_01'].filter((id) => assets.has('models', id));
    const broad = ['island_tree_02', 'tree_small_02'].filter((id) => assets.has('models', id));
    if (conifers.length || broad.length) {
      const g = new THREE.Group();
      for (const [list, kind, targetH] of [[conifers, 'pine', 15], [broad, 'oak', 9]] as const) {
        if (!list.length) continue;
        // LOD: scanned trees in the near ring (where detail is visible), cheap instanced trees beyond
        const spots = this.treeSpots.filter((s) => s.kind === kind && Math.hypot(s.x, s.z) < NEAR_TREES);
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          const size = await assets.size(id);
          if (!size) continue;
          const mine = spots.filter((_, i) => i % list.length === k);
          const tf = mine.map((s) => place(s.x, s.y, s.z, s.rot, (targetH * s.s * (0.8 + ((s.x * 13) % 1 + 1) % 1 * 0.4)) / size.y));
          const inst = await assets.instanced(id, tf, { patch: foliage('tree') });
          if (inst) { g.add(inst); rep.push(`${mine.length}× ${id}`); }
        }
      }
      if (g.children.length) {
        if (this.forestGroup) this.scene.remove(this.forestGroup);
        this.forestGroup = forest(this.treeSpots.filter((s) => Math.hypot(s.x, s.z) >= NEAR_TREES));
        this.scene.add(g, this.forestGroup);
      }
    }

    // 4 — ground cover: grass clumps, ferns, shrubs, nettles
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const clear = (x: number, z: number, pad = 0) => this.pathFactor(x, z) < 0.1 && !this.footprints.some((f) => (x - f.x) ** 2 + (z - f.z) ** 2 < (f.r + pad) ** 2) && (x - 2.5) ** 2 + (z - 2) ** 2 > 8 ** 2;
    const scatter = async (id: string, count: number, rMin: number, rMax: number, sMin: number, sMax: number, pad = 0, mode: 'tree' | 'plant' = 'plant') => {
      const tf: THREE.Matrix4[] = [];
      for (let tries = 0; tf.length < count && tries < count * 20; tries++) {
        const a = rnd() * Math.PI * 2, r = rMin + Math.sqrt(rnd()) * (rMax - rMin);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!clear(x, z, pad) || this.groundY(x, z) > 7) continue;
        tf.push(place(x, this.groundY(x, z) - 0.03, z, rnd() * 6.28, sMin + rnd() * (sMax - sMin)));
      }
      const inst = await assets.instanced(id, tf, { shadows: mode === 'tree', patch: foliage(mode) });
      if (inst) { this.scene.add(inst); rep.push(`${tf.length}× ${id}`); }
    };
    await scatter('grass_medium_01', QUALITY.low ? 120 : 600, 6, 45, 0.8, 1.4);
    await scatter('grass_medium_02', QUALITY.low ? 80 : 500, 6, 45, 0.8, 1.5);
    await scatter('fern_02', QUALITY.low ? 40 : 260, 20, 60, 0.8, 1.6);
    await scatter('nettle_plant', QUALITY.low ? 20 : 120, 8, 40, 0.8, 1.3, 0.5);
    await scatter('shrub_01', QUALITY.low ? 10 : 60, 14, 50, 0.7, 1.3, 1, 'tree');
    await scatter('shrub_04', QUALITY.low ? 10 : 60, 10, 45, 0.7, 1.3, 1, 'tree');

    // 5 — rocks, stumps, fallen trunks
    if (assets.has('models', 'rock_moss_set_01')) {
      const tf = this.rockSpots.map((r) => place(r.x, r.y - 0.1, r.z, r.x * 7, Math.max(0.5, r.s * 0.9)));
      const inst = await assets.instanced('rock_moss_set_01', tf);
      if (inst) { if (this.rockGroup) this.scene.remove(this.rockGroup); this.scene.add(inst); rep.push(`${tf.length}× rock_moss_set_01`); }
    }
    await scatter('boulder_01', 14, 34, 70, 1.5, 3.2, 2, 'tree');
    await scatter('tree_stump_01', 18, 22, 55, 0.8, 1.3, 1, 'tree');
    await scatter('dead_tree_trunk', 6, 26, 55, 0.9, 1.2, 2, 'tree');

    // 6 — props: barrels, crates, buckets, lanterns, statues
    const prop = async (id: string, x: number, z: number, yaw = 0, s = 1, dy = 0) => {
      const o = await assets.clone(id);
      if (!o) return false;
      o.position.set(x, this.groundY(x, z) + dy, z);
      o.rotation.y = yaw;
      o.scale.setScalar(s);
      this.scene.add(o);
      return true;
    };
    let props = 0;
    if (assets.has('models', 'wine_barrel_01') && assets.has('models', 'wooden_crate_01')) {
      for (const o of this.procProps) this.scene.remove(o);
      for (const [x, z, k] of this.propSpots) if (await prop(k ? 'wooden_crate_01' : 'wine_barrel_01', x, z, x * 3)) props++;
    }
    for (const [id, x, z, yaw] of [
      ['wooden_barrels_01', 14.8, 2.2, 0.4], ['wooden_bucket_01', -11.2, 12.6, 1], ['wooden_bucket_01', -9.6, -2.4, 2],
      ['stone_fire_pit', -3.5, 7.5, 0], ['treasure_chest', 16.5, 11.2, -0.8], ['gothic_statue', -0.5, -16.5, 0], ['gothic_statue', 5.5, -16.5, 0],
      ['tree_stump_01', -6.8, -1.6, 0.5], ['wooden_crate_01', 10.5, -0.2, 0.3],
    ] as [string, number, number, number][]) if (await prop(id, x, z, yaw)) props++;
    // hanging lantern under the inn sign
    if (await prop('Lantern_01', 9.2, 0.4, 0, 1, 2.1)) props++;
    if (props) rep.push(`${props} scanned props`);

    this.assetReport = rep;
    this.envDirty = true;
  }

  private ridges = new Ridges();
  private smokes: THREE.Points[] = [];

  private pathFactor(x: number, z: number) {
    const r = Math.hypot(x - 2.5, z - 2);
    return Math.max(
      1 - (Math.abs(x - 2.5) - 1.2) / 1.6 * (z > -20 && z < 28 ? 1 : 9),
      1 - (Math.abs(z - 2) - 1) / 1.8 * (x > -14 && x < 16 ? 1 : 9),
      1 - (r - 7.5) / 2,
    );
  }

  private box(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, shadow = true) {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  }

  /** Soft, rising, expanding smoke column. */
  private smokeAt(p: THREE.Vector3) {
    const N = QUALITY.low ? 12 : 36;
    const g = new THREE.BufferGeometry();
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) seeds[i] = i / N;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMap: { value: softSprite() }, uPx: { value: 1 } },
      transparent: true, depthWrite: false,
      vertexShader: `attribute float seed; uniform float uTime; varying float vA;
        void main(){ float age = fract(uTime*0.07 + seed); vec3 p = position + vec3(sin(seed*40.0+uTime*0.3)*age*1.5 + age*2.5, age*9.0, cos(seed*30.0)*age*1.2);
          vA = smoothstep(0.0, 0.1, age) * (1.0 - age) * 0.32;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = (40.0 + age*260.0) / -mv.z * 6.0; }`,
      fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(vec3(0.42,0.4,0.44), a*vA); }`,
    });
    const pts = new THREE.Points(g, m);
    pts.position.copy(p);
    pts.frustumCulled = false;
    this.smokes.push(pts);
    this.scene.add(pts);
  }

  private addNpc(def: NpcDef) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const fabric = cloth();
    const cloak = applyPBR(new THREE.MeshStandardMaterial({ color: def.color, roughness: 1 }), fabric, 3, 0.8);
    const under = applyPBR(new THREE.MeshStandardMaterial({ color: new THREE.Color(def.color).multiplyScalar(0.45), roughness: 1 }), fabric, 3, 0.8);
    const skin = new THREE.MeshPhysicalMaterial({ color: '#c99474', roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#ffccaa') });
    const hair = new THREE.MeshStandardMaterial({ color: def.id === 'maera' ? '#7a3a1c' : def.id === 'doran' ? '#1c1410' : '#2a1e16', roughness: 0.7 });
    const leather = new THREE.MeshStandardMaterial({ color: '#3a2618', roughness: 0.6 });
    // robe: smooth lathe with flared hem and folds
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const y = (i / 16) * 1.42;
      const t = y / 1.42;
      const r = 0.43 - t * 0.2 + Math.pow(1 - t, 6) * 0.05 + (t > 0.82 ? (t - 0.82) * 0.5 : 0) - (t > 0.93 ? (t - 0.93) * 3.2 : 0);
      prof.push(new THREE.Vector2(Math.max(0.02, r), y));
    }
    const robeG = new THREE.LatheGeometry(prof, 36);
    const rp = robeG.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i);
      const a = Math.atan2(z, x), fold = 1 + Math.sin(a * 9) * 0.035 * (1 - y / 1.42);
      rp.setXYZ(i, x * fold, y, z * fold * 0.82);
    }
    robeG.computeVertexNormals();
    const robe = new THREE.Mesh(robeG, cloak);
    robe.castShadow = true;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.035, 8, 32), leather);
    belt.rotation.x = Math.PI / 2;
    belt.scale.z = 0.82;
    belt.position.y = 0.95;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.12, 16), under);
    collar.position.y = 1.47;
    const headG = new THREE.SphereGeometry(0.155, 32, 24);
    headG.scale(0.92, 1.08, 0.98);
    const head = new THREE.Mesh(headG, skin);
    head.position.y = 1.66;
    head.castShadow = true;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.07, 8), skin);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.65, 0.15);
    body.add(robe, belt, collar, head, nose);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.2 }));
      eye.position.set(sx * 0.055, 1.69, 0.135);
      body.add(eye);
    }
    if (def.id === 'seren' || def.id === 'ilsa') {
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.205, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), cloak);
      hood.position.set(0, 1.68, -0.02);
      hood.rotation.x = -0.35;
      hood.castShadow = true;
      const cape = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.46, 1.2, 28, 6, true, Math.PI * 0.25, Math.PI * 1.5), addWind(cloak.clone(), 'cloth'));
      cape.position.y = 0.9;
      cape.rotation.y = Math.PI;
      (cape.material as THREE.Material).side = THREE.DoubleSide;
      cape.castShadow = true;
      body.add(hood, cape);
    } else {
      const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.165, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
      hairM.position.y = 1.68;
      hairM.rotation.x = -0.25;
      body.add(hairM);
    }
    if (def.id === 'ilsa') {
      const steel = new THREE.MeshStandardMaterial({ color: '#b8bcc4', metalness: 1, roughness: 0.28 });
      const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 2.5, 10), M.timber());
      spear.position.set(0.42, 1.15, 0.08);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 10), steel);
      tip.position.set(0.42, 2.52, 0.08);
      const pauldron = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), steel);
      pauldron.position.set(0.27, 1.38, 0);
      const pauldron2 = pauldron.clone();
      pauldron2.position.x = -0.27;
      body.add(spear, tip, pauldron, pauldron2);
    }
    if (def.id === 'doran') {
      const apron = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.42, 0.9, 20, 1, true, -0.9, 1.8), leather);
      apron.position.set(0, 0.75, 0.02);
      (apron.material as THREE.Material).side = THREE.DoubleSide;
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 12), hair);
      beard.rotation.x = Math.PI;
      beard.position.set(0, 1.55, 0.1);
      body.add(apron, beard);
      body.scale.set(1.15, 1.05, 1.15);
    }
    if (def.id === 'maera') {
      const apron = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.4, 0.8, 20, 1, true, -0.8, 1.6), new THREE.MeshStandardMaterial({ color: '#d8ceb8', roughness: 0.95, side: THREE.DoubleSide }));
      apron.position.set(0, 0.6, 0.02);
      body.add(apron);
    }
    const armGeo = new THREE.CapsuleGeometry(0.065, 0.48, 6, 16);
    armGeo.translate(0, -0.28, 0);
    const armL = new THREE.Mesh(armGeo, cloak), armR = new THREE.Mesh(armGeo, cloak);
    armL.position.set(-0.29, 1.38, 0);
    armR.position.set(0.29, 1.38, 0);
    for (const a of [armL, armR]) {
      a.castShadow = true;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), skin);
      hand.position.y = -0.6;
      a.add(hand);
    }
    body.add(armL, armR);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.65, 40), new THREE.MeshBasicMaterial({ color: '#ffd27d', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    root.add(ring);
    const el = document.createElement('div');
    el.className = 'label npc-label';
    el.innerHTML = `<b>${def.name}</b><span>${def.role}</span>`;
    const label = new CSS2DObject(el);
    label.position.set(0, 2.15, 0);
    root.add(label);
    root.traverse((o) => (o.userData.npcId = def.id));
    const wp = WAYPOINTS[def.routine.dusk];
    root.position.set(wp[0], this.groundY(wp[0], wp[1]), wp[1]);
    this.scene.add(root);
    this.npcs.set(def.id, { def, root, body, label, target: root.position.clone(), armL, armR, ring, walking: false, phase: Math.random() * 6, approachPlayer: false });
  }

  groundY(x: number, z: number) {
    return terrainHeight(x, z);
  }

  pickables() {
    return [...super.pickables(), ...[...this.npcs.values()].filter((n) => n.root.visible).map((n) => n.root)];
  }

  protected applyEnv(e: Env) {
    const u = this.sky.uniforms;
    const presets = {
      dawn: { top: '#33507f', hor: '#f0a27a', bot: '#2a2030', sun: '#ffb27e', sunI: 2.2, sunPos: [80, 12, -40], hemi: 0.55, fog: '#a07c80', stars: 0.15, lan: 0.6, cloudDark: '#4a3a4a', exp: 0.95 },
      day: { top: '#3c6fb8', hor: '#b9cde0', bot: '#55604a', sun: '#fff1dc', sunI: 3.4, sunPos: [40, 70, -20], hemi: 0.9, fog: '#9aaabb', stars: 0, lan: 0, cloudDark: '#8a96a8', exp: 0.85 },
      dusk: { top: '#0f1a40', hor: '#e8784a', bot: '#141420', sun: '#ffa060', sunI: 3.2, sunPos: [-80, 11, -55], hemi: 0.55, fog: '#3c4260', stars: 0.4, lan: 1, cloudDark: '#262038', exp: 1.1 },
      night: { top: '#02030a', hor: '#121a36', bot: '#020205', sun: '#9ab0ff', sunI: 0.5, sunPos: [-30, 60, 30], hemi: 0.16, fog: '#0c1020', stars: 1, lan: 1.5, cloudDark: '#0a0c16', exp: 1.15 },
    }[e.timeOfDay];
    u.uTop.value.set(presets.top);
    u.uHorizon.value.set(presets.hor);
    u.uBottom.value.set(presets.bot);
    u.uSunColor.value.set(presets.sun);
    u.uSun.value = e.timeOfDay === 'night' ? 0.2 : 1;
    u.uStars.value = presets.stars;
    u.uNebula.value = presets.stars * 0.3;
    u.uSunDir.value.set(...(presets.sunPos as [number, number, number])).normalize();
    u.uCloudDark.value.set(presets.cloudDark);
    u.uClouds.value = e.weather === 'storm' ? 1 : e.weather === 'clear' ? 0.75 : 0.95;
    this.sun.position.set(...(presets.sunPos as [number, number, number]));
    this.sunWorld = (u.uSunDir.value as THREE.Vector3).clone().multiplyScalar(800);
    this.look.exposure = presets.exp;
    this.look.godRays = e.timeOfDay === 'night' || e.weather === 'storm' ? 0 : e.timeOfDay === 'day' ? 0.25 : 0.6;
    this.envDirty = true;
    this.sun.color.set(presets.sun);
    this.sun.intensity = presets.sunI * (e.weather === 'storm' || e.weather === 'rain' ? 0.45 : 1);
    this.hemi.intensity = presets.hemi;
    const fogC = new THREE.Color(presets.fog);
    if (e.skyColor) {
      u.uTintAmt.value = 0.6;
      u.uTint.value.set(e.skyColor);
      fogC.lerp(new THREE.Color(e.skyColor), 0.5);
    } else u.uTintAmt.value = 0;
    if (e.weather === 'storm') fogC.multiplyScalar(0.5);
    // Real photographed sky (HDRI) for dawn/dusk/day when available: it becomes the
    // background AND the image-based light, and the key light follows its sun.
    const useHdr = !!this.hdr && e.timeOfDay !== 'night' && !e.skyColor && e.weather !== 'storm';
    this.sky.mesh.visible = !useHdr;
    this.scene.background = useHdr ? this.hdr!.texture : null;
    this.envTexture = useHdr ? this.hdr!.texture : undefined;
    this.scene.environmentIntensity = useHdr ? 0.45 : 1;
    this.scene.backgroundIntensity = 0.9;
    if (useHdr) {
      const d = this.hdr!.sunDir.clone();
      if (d.y < 0.06) d.y = 0.06;
      d.normalize();
      this.sun.position.copy(d.clone().multiplyScalar(120));
      this.sunWorld = d.clone().multiplyScalar(800);
      fogC.copy(this.hdr!.horizon);
      const lum = fogC.r * 0.2126 + fogC.g * 0.7152 + fogC.b * 0.0722;
      fogC.multiplyScalar(Math.min(1, 0.16 / Math.max(1e-3, lum)));
      const z = this.hdr!.zenith;
      this.hemi.color.copy(z).multiplyScalar(1 / Math.max(1e-3, z.r, z.g, z.b));
      this.hemi.intensity = 0.12;
      this.sun.intensity = (e.timeOfDay === 'day' ? 5 : 6) * (e.weather === 'rain' ? 0.45 : 1);
      this.sun.color.set(e.timeOfDay === 'day' ? '#fff0dc' : '#ffb070');
      this.look.exposure = e.timeOfDay === 'day' ? 0.7 : 0.85;
      this.look.contrast = 1.2;
      this.look.saturation = 1.05;
    }
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(fogC);
    fog.density = (useHdr ? 0.0015 + e.fog * 0.008 : 0.003 + e.fog * 0.016) + (e.weather === 'storm' ? 0.008 : 0);
    u.uAurora.value = e.weather === 'aurora' ? 1 : 0;
    this.weather.set(e.weather);
    for (const l of this.lanternLights) l.intensity = 8 * presets.lan;
    M.glassWarm().emissiveIntensity = presets.lan > 0.3 ? 2.2 * presets.lan : 0.15;
    this.ridges.tint(new THREE.Color(presets.bot).lerp(new THREE.Color('#202434'), 0.5), fogC);
  }

  sync(state: WorldState, t: number) {
    super.sync(state, t);
    this.story = state.story;
    const o = state.story.outcome;
    this.crown.visible = o?.kind === 'truth_revealed';
    this.hollowMat.uniforms.uStrength.value = o?.kind === 'truth_revealed' ? 0.15 : o?.kind === 'injustice' ? 1.1 : 0.7;
    for (const [id, v] of this.npcs) v.root.visible = !state.story.npcs[id]?.arrested;
    this.talkingTo = state.activeRealm === 'village' ? state.story.activeConversation : undefined;
  }

  onEnter(state: WorldState) {
    if (!this.greeted && !state.story.transcript.length) {
      // Captain Ilsa notices the stranger and walks over.
      const ilsa = this.npcs.get('ilsa');
      if (ilsa) ilsa.approachPlayer = true;
    }
  }

  update(ctx: FrameCtx) {
    super.update(ctx);
    const t = ctx.t;
    this.sky.uniforms.uTime.value = t;
    this.sky.uniforms.uLightning.value = this.weather.lightning;
    this.hollowMat.uniforms.uTime.value = t;
    for (const m of [this.fireflies, this.embers, ...this.smokes]) (m.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    WIND.uTime.value = t;
    WIND.uWind.value = this.env?.weather === 'storm' ? 3 : this.env?.weather === 'rain' ? 1.6 : 1;
    if (ctx.frozen) return;
    this.forgeLight.intensity = 22 + Math.sin(t * 13) * 3 + Math.sin(t * 31) * 2;
    if (this.crown.visible) this.crown.rotation.y += ctx.dt;
    this.weather.update(ctx.dt, ctx.camera.position, this.env?.gravity ?? 1, t);
    if (this.env?.weather === 'storm') this.hemi.intensity = 0.25 + this.weather.lightning * 2;

    const tod = this.story?.timeOfDay ?? 'dusk';
    const cam = ctx.camera.position;
    for (const [id, v] of this.npcs) {
      if (!v.root.visible) continue;
      const talking = this.talkingTo === id;
      v.ring.visible = talking;
      let goal: THREE.Vector3;
      if (v.approachPlayer && ctx.active) {
        goal = new THREE.Vector3(cam.x, 0, cam.z);
        const d = Math.hypot(cam.x - v.root.position.x, cam.z - v.root.position.z);
        if (d < 3.2) {
          v.approachPlayer = false;
          this.greeted = true;
          this.onApproach?.(id);
        }
      } else {
        const wp = WAYPOINTS[v.def.routine[tod]];
        // small idle wander around the waypoint
        const wob = Math.sin(t * 0.13 + v.phase) * 1.6;
        goal = new THREE.Vector3(wp[0] + wob, 0, wp[1] + Math.cos(t * 0.11 + v.phase) * 1.6);
      }
      const p = v.root.position;
      const dx = goal.x - p.x, dz = goal.z - p.z;
      const dist = Math.hypot(dx, dz);
      v.walking = !talking && dist > (v.approachPlayer ? 0.1 : 0.6);
      if (v.walking) {
        const sp = Math.min(dist, (v.approachPlayer ? 2.2 : 1.3) * ctx.dt);
        p.x += (dx / dist) * sp;
        p.z += (dz / dist) * sp;
        v.root.rotation.y = lerpAngle(v.root.rotation.y, Math.atan2(dx, dz), Math.min(1, ctx.dt * 6));
      } else if (talking || v.approachPlayer) {
        v.root.rotation.y = lerpAngle(v.root.rotation.y, Math.atan2(cam.x - p.x, cam.z - p.z), Math.min(1, ctx.dt * 5));
      }
      p.y = this.groundY(p.x, p.z);
      const sw = v.walking ? Math.sin(t * 7 + v.phase) : Math.sin(t * 1.5 + v.phase) * 0.08;
      v.armL.rotation.x = sw * 0.6;
      v.armR.rotation.x = -sw * 0.6;
      if (talking) v.armR.rotation.x = -0.4 + Math.sin(t * 5) * 0.25;
      v.body.position.y = v.walking ? Math.abs(Math.sin(t * 7 + v.phase)) * 0.06 : Math.sin(t * 1.5 + v.phase) * 0.015;
    }
  }

  focusPoint(kind: string, id: string) {
    if (kind === 'npc') {
      const v = this.npcs.get(id);
      if (v) return v.root.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    }
    return super.focusPoint(kind, id);
  }

  info(s: WorldState): InfoCard {
    const st = s.story;
    const clues = FACTS.filter((f) => f.clue);
    const known = clues.filter((f) => st.playerKnows.includes(f.id));
    const npcRows = NPCS.map((n) => {
      const ns = st.npcs[n.id];
      const pct = (ns.disposition + 100) / 2;
      return `<div class="npc-row"><span>${n.name}${ns.arrested ? ' <em>(arrested)</em>' : ''}</span><div class="bar"><i style="width:${pct}%;background:${ns.disposition >= 0 ? '#7df9a0' : '#ff6b8a'}"></i></div></div>`;
    }).join('');
    const clueList = known.length ? known.map((f) => `<li>${escapeHtml(f.text)}</li>`).join('') : '<li class="muted">Nothing yet. Talk to the villagers.</li>';
    return {
      title: `Emberfall · ${st.title}`,
      mode: 'IMAGINATIVE REALITY',
      subtitle: st.outcome ? st.outcome.summary : 'The Ember Crown has vanished. Without it, the Hollow creeps closer every dusk. Who took it — and why?',
      accuracy: [
        { tag: 'FICTION', text: 'An original story. Its facts are authored and authoritative: they are stored by the engine, not invented by the AI.' },
        { tag: 'MODEL', text: 'What villagers say is generated live (Nemotron) or by offline dialogue. They can lie or be wrong; only facts they genuinely reveal enter your journal.' },
        ...(this.assetReport.length ? [{ tag: 'MEASURED' as const, text: `Photogrammetry & scanned assets (CC0, Poly Haven): ${this.assetReport.join(' · ')}.` }] : []),
      ],
      stats: [
        { label: 'Time', value: st.timeOfDay },
        { label: 'Clues', value: `${known.length} / ${clues.length}` },
        { label: 'Reputation', value: String(st.reputation) },
      ],
      extraHtml: `<h4>Journal — verified facts</h4><ul class="clues">${clueList}</ul><h4>How they see you</h4>${npcRows}`,
    };
  }
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Small pyramidal tiled roof for wells and towers. */
function halfRoof(w: number, d: number, h: number) {
  const g = new THREE.ConeGeometry(Math.hypot(w, d) / 2, h, 4, 1);
  g.rotateY(Math.PI / 4);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 1.2);
  const m = new THREE.Mesh(g, M.roof('#3a2c2c'));
  m.castShadow = true;
  return m;
}
