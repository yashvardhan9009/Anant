/**
 * Architecture & nature kit for the imaginative realms. Procedural, textured,
 * instanced where it matters (grass, trees, rocks) and animated by wind.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { stoneBricks, plaster, timber, roofTiles, rock, applyPBR, groundDetail } from './textures';
import { QUALITY } from './quality';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// ———————————————————————————————— wind ————————————————————————————————
export const WIND = { uTime: { value: 0 }, uWind: { value: 1 } };

/** Inject wind sway into a standard material. `mode` decides how displacement scales with height. */
const WIND_SNIPPETS: Record<'grass' | 'tree' | 'cloth' | 'plant', string> = {
  grass: 'float k = position.y * position.y; transformed.x += sin(uTime * 2.2 + ph) * 0.22 * k * uWind * gust; transformed.z += cos(uTime * 1.7 + ph) * 0.12 * k * uWind * gust;',
  tree: 'float k = pow(max(0.0, position.y - 1.5), 2.0) * 0.004; transformed.x += sin(uTime * 1.1 + ph) * k * uWind * gust; transformed.z += cos(uTime * 0.9 + ph) * k * 0.6 * uWind * gust;',
  plant: 'float k = max(0.0, position.y) * 0.18; transformed.x += sin(uTime * 2.0 + ph) * k * uWind * gust; transformed.z += cos(uTime * 1.6 + ph) * k * 0.6 * uWind * gust;',
  cloth: 'float k = max(0.0, -position.y + 0.5); transformed.z += sin(uTime * 3.0 + position.x * 3.0) * 0.08 * k * uWind;',
};

/** Inject wind sway into a standard material. `mode` decides how displacement scales with height. */
export function addWind(m: THREE.MeshStandardMaterial, mode: keyof typeof WIND_SNIPPETS) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = WIND.uTime;
    sh.uniforms.uWind = WIND.uWind;
    sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 wpos0 = vec4(position, 1.0);
      #ifdef USE_INSTANCING
      wpos0 = instanceMatrix * wpos0;
      #endif
      wpos0 = modelMatrix * wpos0;
      float ph = wpos0.x * 0.35 + wpos0.z * 0.27;
      float gust = 0.6 + 0.4 * sin(uTime * 0.6 + wpos0.x * 0.05);
      ${WIND_SNIPPETS[mode]}`,
    );
  };
  m.customProgramCacheKey = () => 'wind-' + mode;
  return m;
}

// ———————————————————————————————— shared materials ————————————————————————————————
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(key: string, f: () => THREE.MeshStandardMaterial) {
  if (!matCache.has(key)) matCache.set(key, f());
  return matCache.get(key)!;
}
export const M = {
  stone: () => mat('stone', () => applyPBR(new THREE.MeshStandardMaterial({ color: '#c8c0b4', roughness: 1 }), stoneBricks(), 1, 1.2)),
  plaster: () => mat('plaster', () => applyPBR(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 }), plaster(), 1, 0.6)),
  timber: () => mat('timber', () => applyPBR(new THREE.MeshStandardMaterial({ color: '#b09080', roughness: 1 }), timber(), 1, 1)),
  roof: (tint: string) => mat('roof' + tint, () => applyPBR(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, side: THREE.DoubleSide }), roofTiles(tint), 1, 1.4)),
  rock: () => mat('rock', () => applyPBR(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 }), rock(), 1, 1.5)),
  iron: () => mat('iron', () => new THREE.MeshStandardMaterial({ color: '#2a2a2e', metalness: 0.85, roughness: 0.45 })),
  glassWarm: () => mat('glassWarm', () => new THREE.MeshStandardMaterial({ color: '#231c16', emissive: '#b47737', emissiveIntensity: .35, roughness: 0.18, metalness: 0.4 })),
  cobble: () => mat('cobble', () => applyPBR(new THREE.MeshStandardMaterial({ color: '#a59d92', roughness: 1 }), stoneBricks(), 6, 1.6)),
};

/** Box with UVs scaled to world size so textures keep a consistent texel density. */
export function worldBox(w: number, h: number, d: number, texScale = 0.35) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    const [a, b] = nx > 0.5 ? [d, h] : ny > 0.5 ? [w, d] : [w, h];
    uv.setXY(i, uv.getX(i) * a * texScale, uv.getY(i) * b * texScale);
  }
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  o.receiveShadow = true;
  return o;
}

// ———————————————————————————————— buildings ————————————————————————————————
export interface HouseOpts { w: number; d: number; h: number; floors?: 1 | 2; roof?: string; jetty?: boolean; chimney?: boolean; seed?: number }

/** Half-timbered house: stone plinth, plaster walls, exposed timber frame, tiled gable roof, lit windows. */
export function halfTimberHouse(o: HouseOpts) {
  const g = new THREE.Group();
  const floors = o.floors ?? 1;
  const fh = o.h / floors;
  const plinth = 0.55;
  g.add(mesh(worldBox(o.w + 0.25, plinth, o.d + 0.25, 0.5), M.stone(), 0, plinth / 2, 0));
  const beams: THREE.BufferGeometry[] = [];
  const beam = (w: number, h: number, d: number, x: number, y: number, z: number, rz = 0, ry = 0) => {
    const b = worldBox(w, h, d, 0.6);
    b.rotateZ(rz);
    b.rotateY(ry);
    b.translate(x, y, z);
    beams.push(b);
  };
  const T = 0.16;
  let topW = o.w, topD = o.d;
  for (let f = 0; f < floors; f++) {
    const jet = o.jetty && f > 0 ? 0.35 : 0;
    const W = o.w + jet * 2, D = o.d + jet * 2;
    topW = W; topD = D;
    const y0 = plinth + f * fh;
    const nWin = Math.max(1, Math.round(W / 2.2));
    // Wall thickness and actual apertures create occlusion and a visible reveal.
    for (const side of [-1, 1]) {
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(W / 2, fh); shape.lineTo(-W / 2, fh); shape.closePath();
      for (let i = 0; i < nWin; i++) {
        const wx = -W / 2 + W * (i + .5) / nWin;
        if (f === 0 && Math.abs(wx) < .7) continue;
        const hole = new THREE.Path();
        hole.moveTo(wx - .34, fh * .55 - .42); hole.lineTo(wx - .34, fh * .55 + .42);
        hole.lineTo(wx + .34, fh * .55 + .42); hole.lineTo(wx + .34, fh * .55 - .42); hole.closePath(); shape.holes.push(hole);
      }
      const facade = new THREE.ExtrudeGeometry(shape, { depth: .24, bevelEnabled: true, bevelSize: .015, bevelThickness: .015, bevelSegments: 1, steps: 1 });
      const uv = facade.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * .45, uv.getY(i) * .45);
      const face = mesh(facade, M.plaster(), 0, y0, side * (D / 2 - .24));
      face.rotation.y = side > 0 ? 0 : Math.PI; g.add(face);
      g.add(mesh(worldBox(.24, fh, D - .4, .45), M.plaster(), side * (W / 2 - .12), y0 + fh / 2, 0));
    }
    const interior = mesh(worldBox(W - .6, fh - .3, D - .65), mat('interior', () => new THREE.MeshStandardMaterial({ color: '#221c15', roughness: 1 })), 0, y0 + fh / 2, 0);
    g.add(interior);
    // frame on each face
    for (const side of [-1, 1]) {
      // front/back faces (along x)
      const z = side * (D / 2 + 0.02);
      beam(W + 0.05, T, T * 0.6, 0, y0 + T / 2, z);
      beam(W + 0.05, T, T * 0.6, 0, y0 + fh - T / 2, z);
      const studs = Math.max(2, Math.round(W / 1.25));
      for (let i = 0; i <= studs; i++) beam(T, fh, T * 0.6, -W / 2 + (W * i) / studs, y0 + fh / 2, z);
      const diag = Math.atan2(fh, W / studs);
      beam(Math.hypot(fh, W / studs), T * 0.9, T * 0.5, -W / 2 + W / studs / 2, y0 + fh / 2, z, side > 0 ? diag : -diag);
      beam(Math.hypot(fh, W / studs), T * 0.9, T * 0.5, W / 2 - W / studs / 2, y0 + fh / 2, z, side > 0 ? -diag : diag);
      // side faces (along z)
      const x = side * (W / 2 + 0.02);
      beam(T * 0.6, T, D + 0.05, x, y0 + T / 2, 0);
      beam(T * 0.6, T, D + 0.05, x, y0 + fh - T / 2, 0);
      const sz = Math.max(2, Math.round(D / 1.25));
      for (let i = 0; i <= sz; i++) beam(T * 0.6, fh, T, x, y0 + fh / 2, -D / 2 + (D * i) / sz);
    }
    // windows (front & back), warm glass with frame + mullions
    for (let i = 0; i < nWin; i++) {
      const wx = -W / 2 + (W * (i + 0.5)) / nWin;
      if (f === 0 && Math.abs(wx) < 0.7) continue; // door goes here
      for (const side of [-1, 1]) {
        const z = side * (D / 2 + 0.03);
        const win = mesh(new THREE.PlaneGeometry(0.62, 0.78), M.glassWarm(), wx, y0 + fh * 0.55, z - side * .18, false);
        win.rotation.y = side > 0 ? 0 : Math.PI;
        g.add(win);
        beam(0.78, 0.09, 0.1, wx, y0 + fh * 0.55 + 0.42, z);
        beam(0.78, 0.09, 0.1, wx, y0 + fh * 0.55 - 0.42, z);
        beam(0.06, 0.78, 0.08, wx, y0 + fh * 0.55, z);
        beam(0.62, 0.05, 0.08, wx, y0 + fh * 0.55, z);
        beam(.08, .88, .18, wx - .36, y0 + fh * .55, z);
        beam(.08, .88, .18, wx + .36, y0 + fh * .55, z);
        beam(.92, .10, .32, wx, y0 + fh * .55 - .46, z);
        // Open wooden shutters, with iron straps and individual boards.
        for (const sx of [-1, 1]) {
          for (let b = 0; b < 3; b++) beam(.105, .86, .055, wx + sx * (.48 + b * .11), y0 + fh * .55, z + side * .05);
          for (const dy of [-.28, .28]) g.add(mesh(worldBox(.31, .045, .045), M.iron(), wx + sx * .59, y0 + fh * .55 + dy, z + side * .09));
        }
      }
    }
  }
  // door
  const door = mesh(worldBox(0.95, 1.75, 0.08, 1), M.timber(), 0, plinth + 0.875, o.d / 2 + 0.05);
  g.add(door);
  for (let i = 0; i < 6; i++) g.add(mesh(worldBox(.14, 1.72, .05, 1), M.timber(), -.385 + i * .154, plinth + .875, o.d / 2 + .11));
  for (const y of [.38, 1.36]) g.add(mesh(worldBox(.88, .07, .045), M.iron(), 0, plinth + y, o.d / 2 + .15));
  const handle = mesh(new THREE.TorusGeometry(.055, .012, 8, 16), M.iron(), .3, plinth + .9, o.d / 2 + .19); g.add(handle);
  g.add(mesh(worldBox(1.55, .18, .8, .6), M.stone(), 0, .18, o.d / 2 + .25));
  beam(1.2, 0.16, 0.14, 0, plinth + 1.8, o.d / 2 + 0.06);
  g.add(mesh(mergeGeometries(beams), M.timber()));

  // gable roof (ridge along x) with overhang
  const roofY = plinth + o.h;
  const rise = Math.max(1.4, topD * 0.55);
  const over = 0.45;
  const slope = Math.hypot(topD / 2 + over, rise);
  const ang = Math.atan2(rise, topD / 2 + over);
  for (const side of [-1, 1]) {
    const slab = new THREE.BoxGeometry(topW + over * 2, 0.14, slope);
    const uv = slab.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (topW + over * 2) * 0.25, uv.getY(i) * slope * 0.25);
    const r = mesh(slab, M.roof(o.roof ?? '#6a3b2c'));
    r.position.set(0, roofY + rise / 2, (side * (topD / 2 + over)) / 2);
    r.rotation.x = side * ang;
    g.add(r);
    if (!QUALITY.low) {
      const cols = Math.ceil((topW + over * 2) / .32), rows = Math.ceil(slope / .34);
      const tile = new RoundedBoxGeometry(.34, .045, .44, 1, .018);
      const clay = mat('physical-roof-' + o.roof, () => new THREE.MeshStandardMaterial({ color: o.roof ?? '#6a3b2c', roughness: .93 }));
      const tiles = new THREE.InstancedMesh(tile, clay, cols * rows);
      const dummy = new THREE.Object3D(), color = new THREE.Color();
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const index = row * cols + col, noise = Math.sin(index * 17.83 + o.w * 7) * .5 + .5;
        dummy.position.set((col + .5) * (topW + over * 2) / cols - (topW + over * 2) / 2, .10 + noise * .012, (row + .5) * slope / rows - slope / 2);
        dummy.rotation.set(.07 * side, 0, (noise - .5) * .025); dummy.updateMatrix();
        tiles.setMatrixAt(index, dummy.matrix); color.setRGB(.72 + noise * .38, .72 + noise * .38, .72 + noise * .38); tiles.setColorAt(index, color);
      }
      tiles.position.copy(r.position); tiles.rotation.copy(r.rotation); tiles.castShadow = tiles.receiveShadow = true; g.add(tiles);
    }
  }
  const ridge = mesh(new THREE.CylinderGeometry(0.11, 0.11, topW + over * 2, 8), M.timber(), 0, roofY + rise + 0.05, 0);
  ridge.rotation.z = Math.PI / 2;
  g.add(ridge);
  // gable ends (plaster triangles)
  const tri = new THREE.Shape([new THREE.Vector2(-topD / 2, 0), new THREE.Vector2(topD / 2, 0), new THREE.Vector2(0, rise)]);
  for (const side of [-1, 1]) {
    const gg = new THREE.ShapeGeometry(tri);
    const uv = gg.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.45, uv.getY(i) * 0.45);
    const gm = mesh(gg, M.plaster(), side * (topW / 2), roofY, 0);
    gm.rotation.y = side * Math.PI / 2;
    (gm.material as THREE.Material).side = THREE.DoubleSide;
    g.add(gm);
  }
  if (o.chimney !== false) {
    const cx = topW * 0.28;
    g.add(mesh(worldBox(0.6, rise + 1.3, 0.6, 0.5), M.stone(), cx, roofY + (rise + 1.3) / 2, -topD * 0.15));
    g.add(mesh(worldBox(0.75, 0.12, 0.75, 0.5), M.stone(), cx, roofY + rise + 1.36, -topD * 0.15));
  }
  g.userData.chimneyTop = new THREE.Vector3(topW * 0.28, roofY + rise + 1.45, -topD * 0.15);
  g.userData.height = roofY + rise;
  return g;
}

export function barrel() {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.9, 14, 4);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), k = 1 + 0.12 * Math.cos((y / 0.45) * Math.PI * 0.5);
    p.setXYZ(i, p.getX(i) * k, y, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  g.add(mesh(geo, M.timber(), 0, 0.45, 0));
  for (const y of [0.15, 0.75]) g.add(mesh(new THREE.TorusGeometry(0.37, 0.025, 6, 20).rotateX(Math.PI / 2), M.iron(), 0, y, 0));
  return g;
}

export function crate(s = 0.7) {
  return mesh(worldBox(s, s, s, 1.2), M.timber(), 0, s / 2, 0);
}

// ———————————————————————————————— nature ————————————————————————————————

function colorize(g: THREE.BufferGeometry, c: THREE.Color, vary = 0.08, seed = 1) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const cc = c.clone().offsetHSL((r() - 0.5) * 0.02, 0, (r() - 0.5) * vary);
    col.set([cc.r, cc.g, cc.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function displace(g: THREE.BufferGeometry, amt: number, freq: number, seed: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * freq + seed) * Math.cos(z * freq * 1.3 + seed * 2) * Math.sin(y * freq * 0.7 + seed * 3);
    const l = Math.hypot(x, y, z) || 1;
    p.setXYZ(i, x + (x / l) * n * amt, y + (y / l) * n * amt, z + (z / l) * n * amt);
  }
  g.computeVertexNormals();
  return g;
}

function stripUV(g: THREE.BufferGeometry) {
  // keep attributes uniform for merging
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

/** A conifer as one vertex-coloured geometry (trunk + drooping tiers). */
function pineGeometry(seed: number) {
  const parts: THREE.BufferGeometry[] = [colorize(stripUV(new THREE.CylinderGeometry(0.12, 0.22, 3, 7).translate(0, 1.5, 0)), new THREE.Color('#3b2a1e'), 0.1, seed)];
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const r = 1.9 * (1 - i / tiers) + 0.35, y = 1.4 + i * 1.05;
    const c = new THREE.ConeGeometry(r, 1.9, 11, 2, true);
    const p = c.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const yy = p.getY(k);
      if (yy < 0) p.setY(k, yy - 0.25 * Math.hypot(p.getX(k), p.getZ(k)) / r); // drooping edges
    }
    displace(c, 0.12, 3, seed + i);
    c.translate(0, y, 0);
    parts.push(colorize(stripUV(c), new THREE.Color('#1f3a26').offsetHSL(0, 0, -i * 0.006), 0.07, seed + i * 7));
  }
  return mergeGeometries(parts)!;
}

/** A broadleaf tree: trunk, limbs and a lumpy crown. */
function oakGeometry(seed: number) {
  const parts: THREE.BufferGeometry[] = [colorize(stripUV(new THREE.CylinderGeometry(0.22, 0.38, 3.2, 8).translate(0, 1.6, 0)), new THREE.Color('#3d2b1f'), 0.08, seed)];
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, d = 0.6 + r() * 1.3, y = 3.6 + r() * 1.8;
    const b = displace(new THREE.IcosahedronGeometry(1.1 + r() * 0.7, 2), 0.18, 2.5, seed + i);
    b.scale(1, 0.8, 1);
    b.translate(Math.cos(a) * d, y, Math.sin(a) * d);
    parts.push(colorize(stripUV(b), new THREE.Color('#2f4a24').offsetHSL(r() * 0.03 - 0.015, 0, r() * 0.05 - 0.02), 0.09, seed + i));
  }
  return mergeGeometries(parts)!;
}

export function forest(spots: { x: number; y: number; z: number; s: number; rot: number; kind: 'pine' | 'oak' }[]) {
  const group = new THREE.Group();
  const m = addWind(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }), 'tree');
  for (const kind of ['pine', 'oak'] as const) {
    const list = spots.filter((p) => p.kind === kind);
    if (!list.length) continue;
    const geo = kind === 'pine' ? pineGeometry(3) : oakGeometry(5);
    const im = new THREE.InstancedMesh(geo, m, list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    list.forEach((p, i) => {
      m4.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromEuler(new THREE.Euler(0, p.rot, 0)), new THREE.Vector3(p.s, p.s * (0.9 + (i % 5) * 0.05), p.s));
      im.setMatrixAt(i, m4);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  }
  return group;
}

/** Instanced grass blades with wind; heights/colours vary per instance. */
export function grassField(count: number, place: () => { x: number; y: number; z: number } | null) {
  const blade = new THREE.BufferGeometry();
  const pos = [-0.012, 0, 0, 0.012, 0, 0, -0.009, 0.45, 0.04, 0.009, 0.45, 0.04, 0, 1, 0.15];
  blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0.3, 0, 1, 0.3, 0, 1, 0.3, 0, 1, 0.3, 0, 1, 0.3], 3));
  blade.setAttribute('color', new THREE.Float32BufferAttribute([0.08, 0.13, 0.05, 0.08, 0.13, 0.05, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.45, 0.5, 0.22], 3));
  blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  const m = addWind(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 }), 'grass');
  const im = new THREE.InstancedMesh(blade, m, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < count && tries < count * 4; tries++) {
    const p = place();
    if (!p) continue;
    const s = 0.12 + Math.random() * 0.22;
    m4.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.3, Math.random() * Math.PI, (Math.random() - 0.5) * 0.3)), new THREE.Vector3(0.6 + Math.random() * 0.6, s, 1));
    im.setMatrixAt(n, m4);
    im.setColorAt(n, c.setHSL(0.22 + Math.random() * 0.06, 0.5, 0.75 + Math.random() * 0.4));
    n++;
  }
  im.count = n;
  im.receiveShadow = true;
  im.frustumCulled = false;
  return im;
}

export function rocks(spots: { x: number; y: number; z: number; s: number }[]) {
  const geo = displace(new THREE.DodecahedronGeometry(1, 1), 0.25, 1.8, 7);
  geo.scale(1, 0.6, 1);
  const im = new THREE.InstancedMesh(geo, M.rock(), spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  spots.forEach((p, i) => {
    m4.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromEuler(new THREE.Euler(Math.random(), Math.random() * 6, Math.random() * 0.4)), new THREE.Vector3(p.s, p.s * (0.6 + Math.random() * 0.6), p.s * (0.8 + Math.random() * 0.4)));
    im.setMatrixAt(i, m4);
  });
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}

/** Distant mountain silhouettes in layers; colours are re-tinted by the sky for atmospheric perspective. */
export class Ridges {
  group = new THREE.Group();
  layers: { mesh: THREE.Mesh; depth: number }[] = [];
  constructor(radii = [150, 230, 340], heights = [38, 70, 120]) {
    radii.forEach((R, li) => {
      const N=256,rows=20,pos:number[]=[],uv:number[]=[],idx:number[]=[];
      for(let row=0;row<=rows;row++)for(let i=0;i<=N;i++){
        const a=i/N*Math.PI*2,t=row/rows;
        let h=0,f=3+li,amp=1;
        for(let o=0;o<6;o++){h+=Math.abs(Math.sin(a*f+li*7.1+o*1.7))*amp;f*=2.13;amp*=.5;}
        const r=R*(.65+t*.55),profile=Math.pow(Math.sin(t*Math.PI),1.3);
        const erosion=Math.sin(a*71+t*15+li)*Math.sin(a*37-t*24)*2.3*profile;
        const height=-10+Math.pow(h/1.9,1.6)*heights[li]*profile+erosion;
        const x=Math.cos(a)*r,z=Math.sin(a)*r;
        pos.push(x,height,z);uv.push(x/9,z/9);
        if(row<rows&&i<N){const k=row*(N+1)+i;idx.push(k,k+N+1,k+1,k+1,k+N+1,k+N+2);}
      }
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
      const material=M.rock().clone();material.color.set('#93918b');material.side=THREE.DoubleSide;
      const mm=new THREE.Mesh(g,material);mm.receiveShadow=true;
      mm.renderOrder = -5 + li;
      this.group.add(mm);
      this.layers.push({ mesh: mm, depth: li / (radii.length - 1) });
    });
  }
  tint(near: THREE.Color, horizon: THREE.Color) {
    for(const l of this.layers)(l.mesh.material as THREE.MeshStandardMaterial).color.set('#a7a39b').lerp(horizon,.12+l.depth*.25);
  }
}

export function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  return applyPBR(m, groundDetail(), 60, 1.2);
}

export { QUALITY };
