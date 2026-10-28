/**
 * Generators for every spawnable ObjectKind. Authored assets are streamed where available:
 * every supported object maps to real geometry, with cancellable asset loading.
 */
import * as THREE from 'three';
import type { ObjectKind } from '../../shared/commands';
import { buildDragon } from './Dragon';
import { assets } from './assets';

export interface Built {
  root: THREE.Group;
  /** materials that take the object's colour */
  tint: THREE.MeshStandardMaterial[];
  /** per-frame animation hook */
  animate?: (t: number, dt: number) => void;
  /** half-height used for ground contact */
  base: number;
  ready?: Promise<void>;
  dispose?: () => void;
}

const std = (color: string | number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, flatShading: false, ...opts });

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

/** Jitter vertices for an organic, hand-made look. */
function roughen(g: THREE.BufferGeometry, amt: number, seed = 1) {
  const r = rng(seed);
  const p = g.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!map.has(k)) map.set(k, [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt]);
    const d = map.get(k)!;
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  g.computeVertexNormals();
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

function castle(color: string): Built {
  const root = new THREE.Group();
  const stone = std(color);
  assets.applyTo(stone, 'castle_brick_01', 2, .6); stone.color.set(color);
  const dark = std('#6b6258');
  const roof = std('#3b2f5c');
  const glowWin = new THREE.MeshBasicMaterial({ color: '#ffc46b' });
  const keep = mesh(new THREE.BoxGeometry(2.2, 3.2, 2.2), stone, 0, 1.6, 0);
  root.add(keep);
  root.add(mesh(new THREE.ConeGeometry(1.7, 1.6, 4), roof, 0, 4, 0)).children.at(-1)!.rotation.set(0, Math.PI / 4, 0);
  for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    root.add(mesh(new THREE.CylinderGeometry(0.55, 0.65, 3.4, 8), stone, x, 1.7, z));
    root.add(mesh(new THREE.ConeGeometry(0.8, 1.4, 8), roof, x, 4.1, z));
    for (let i = 0; i < 3; i++) root.add(mesh(new THREE.BoxGeometry(0.12, 0.3, 0.05), glowWin, x + 0.5 * Math.sign(x), 1 + i * 0.9, z + 0.42 * Math.sign(z)));
  }
  for (const [x, z, w, d] of [[0, -2, 4, 0.4], [0, 2, 4, 0.4], [-2, 0, 0.4, 4], [2, 0, 0.4, 4]]) {
    root.add(mesh(new THREE.BoxGeometry(w, 1.6, d), stone, x, 0.8, z));
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      root.add(mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), dark, x + (w > 1 ? t * w : 0), 1.75, z + (d > 1 ? t * d : 0)));
    }
  }
  root.add(mesh(new THREE.BoxGeometry(0.8, 1.1, 0.1), std('#2a1d12'), 0, 0.55, 2.22));
  const banner = mesh(new THREE.PlaneGeometry(0.5, 0.9), new THREE.MeshStandardMaterial({ color: '#b31d3a', side: THREE.DoubleSide }), 0.3, 5.3, 0);
  root.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6), dark, 0, 5.1, 0), banner);
  return { root, tint: [stone], base: 0, animate: (t) => { banner.rotation.y = Math.sin(t * 2) * 0.3; } };
}

function floatingIsland(color: string): Built {
  const root = new THREE.Group();
  const rock = std('#6d5a4a');
  const grass = std(color);
  const under = mesh(roughen(new THREE.ConeGeometry(3, 4.2, 9, 3), 0.5, 7), rock, 0, -2.1, 0);
  under.rotation.x = Math.PI;
  root.add(under);
  root.add(mesh(roughen(new THREE.CylinderGeometry(3.1, 3, 0.5, 12, 1), 0.15, 3), grass, 0, 0.25, 0));
  const childTrees:Built[]=[];
  const r = rng(11);
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2, d = 0.6 + r() * 1.8;
    const child=tree('#2f7a46', 0.45+r()*.3);childTrees.push(child);const tr=child.root;
    tr.position.set(Math.cos(a) * d, 0.5, Math.sin(a) * d);
    root.add(tr);
  }
  const crystalMat = new THREE.MeshStandardMaterial({ color: '#7df9ff', emissive: '#3fd8ff', emissiveIntensity: 2.2, flatShading: true });
  for (let i = 0; i < 5; i++) {
    const c = mesh(new THREE.OctahedronGeometry(0.25 + r() * 0.2), crystalMat, (r() - 0.5) * 2.5, -1 - r() * 2.5, (r() - 0.5) * 2.5);
    c.scale.y = 2;
    root.add(c);
  }
  // Waterfall: a stream of particles spilling off the edge.
  const N = 220;
  const pos = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) seeds[i] = r();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const water = new THREE.Points(g, new THREE.PointsMaterial({ color: '#9fe8ff', size: 0.12, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  root.add(water);
  return {
    root, tint: [grass], base: -4, dispose:()=>childTrees.forEach(child=>child.dispose?.()),
    animate: (t) => {
      for (let i = 0; i < N; i++) {
        const ph = (t * 0.35 + seeds[i]) % 1;
        pos[i * 3] = 2.9 + ph * 0.6 + Math.sin(seeds[i] * 50) * 0.08;
        pos[i * 3 + 1] = 0.3 - ph * ph * 9;
        pos[i * 3 + 2] = (seeds[i] - 0.5) * 0.7;
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}

function sword(color: string): Built {
  const root = new THREE.Group();
  const blade = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, metalness: 0.9, roughness: 0.2 });
  const shape = new THREE.Shape();
  shape.moveTo(-0.09, 0); shape.lineTo(0.09, 0); shape.lineTo(0.07, 2.2); shape.lineTo(0, 2.55); shape.lineTo(-0.07, 2.2); shape.closePath();
  const bg = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  bg.translate(0, 0, -0.015);
  root.add(mesh(bg, blade, 0, 0.5, 0));
  root.add(mesh(new THREE.BoxGeometry(0.7, 0.08, 0.12), std('#c9a54a', { metalness: 0.8, roughness: 0.3 }), 0, 0.5, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.45), std('#3b2416'), 0, 0.25, 0));
  root.add(mesh(new THREE.SphereGeometry(0.08), std('#c9a54a', { metalness: 0.8 }), 0, 0.02, 0));
  const light = new THREE.PointLight(color, 3, 6, 2);
  light.position.y = 1.5;
  root.add(light);
  return { root, tint: [blade], base: 0, animate: (t) => { light.intensity = 2.5 + Math.sin(t * 3) * 0.6; } };
}

function crystal(color: string): Built {
  const root = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.88, flatShading: true });
  const r = rng(5);
  for (let i = 0; i < 7; i++) {
    const c = mesh(new THREE.OctahedronGeometry(i === 0 ? 0.6 : 0.2 + r() * 0.3, 0), m);
    c.scale.y = i === 0 ? 2.6 : 1.8 + r();
    c.position.set(i === 0 ? 0 : (r() - 0.5) * 1.1, c.scale.y * (i === 0 ? 0.6 : 0.3), i === 0 ? 0 : (r() - 0.5) * 1.1);
    c.rotation.set((r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6);
    root.add(c);
  }
  return { root, tint: [m], base: 0, animate: (t) => { root.children.forEach((c, i) => (c.rotation.y += 0.002 * (i + 1))); m.emissiveIntensity = 1.4 + Math.sin(t * 2) * 0.4; } };
}

export function tree(color: string, s = 1): Built {
  const root = new THREE.Group();
  const leaf = std(color);
  root.add(mesh(new THREE.CylinderGeometry(0.12 * s, 0.18 * s, 1.2 * s, 6), std('#5a3a22'), 0, 0.6 * s, 0));
  for (let i = 0; i < 3; i++) root.add(mesh(roughen(new THREE.ConeGeometry((1 - i * 0.22) * s, 1.3 * s, 7), 0.08 * s, i + 2), leaf, 0, (1.3 + i * 0.6) * s, 0));
  return upgradeProp({ root, tint: [leaf], base: 0 },'island_tree_02',6*s,color);
}

/** Replace the fallback only after the entire streamed prop is ready. Geometry
 * and materials are owned by the instance; the library keeps shared textures. */
function upgradeProp(built:Built,id:string,height:number,color?:string):Built {
  let closed=false;
  built.ready=assets.init().then(async()=>{
    const model=await assets.clone(id);if(!model||closed)return;
    const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3());
    model.scale.multiplyScalar(height/Math.max(.001,size.y));model.position.y-=box.min.y*height/size.y;
    model.traverse(object=>{
      object.userData.objectId=built.root.userData.objectId;
      const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;
      mesh.geometry=mesh.geometry.clone();
      const own=(source:THREE.Material)=>{
        const material=source.clone() as THREE.MeshStandardMaterial;
        if(material.alphaTest>0||material.transparent){material.alphaTest=.35;material.alphaToCoverage=true;material.transparent=false;material.side=THREE.DoubleSide;}
        if(color && material.map)material.color.lerp(new THREE.Color(color),.12);
        built.tint.push(material);return material;
      };
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(own):own(mesh.material);
    });
    built.root.traverse(object=>{const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;mesh.geometry.dispose();for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])material.dispose();});
    built.root.clear();built.root.add(model);built.root.userData.assetLoaded=true;
  }).catch(error=>console.warn('Object asset failed',id,error));
  const dispose=built.dispose;built.dispose=()=>{closed=true;dispose?.();};return built;
}

function tower(color: string): Built {
  const root = new THREE.Group();
  const stone = std(color);
  assets.applyTo(stone, 'stone_wall_04', 3, .5); stone.color.set(color);
  root.add(mesh(roughen(new THREE.CylinderGeometry(0.9, 1.2, 6, 10, 4), 0.06, 4), stone, 0, 3, 0));
  root.add(mesh(new THREE.ConeGeometry(1.3, 2, 10), std('#2e2250'), 0, 7, 0));
  const win = new THREE.MeshBasicMaterial({ color: '#9fe8ff' });
  for (let i = 0; i < 4; i++) {
    const w = mesh(new THREE.BoxGeometry(0.22, 0.4, 0.05), win);
    const a = i * 1.7;
    w.position.set(Math.cos(a) * 1.0, 1.5 + i * 1.2, Math.sin(a) * 1.0);
    w.lookAt(0, w.position.y, 0);
    root.add(w);
  }
  const orb = mesh(new THREE.SphereGeometry(0.25, 16, 12), new THREE.MeshBasicMaterial({ color: '#b388ff' }), 0, 8.2, 0);
  root.add(orb);
  return { root, tint: [stone], base: 0, animate: (t) => { orb.position.y = 8.2 + Math.sin(t * 1.5) * 0.15; } };
}

function orb(color: string): Built {
  const root = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.5, roughness: 0.2 });
  const core = mesh(new THREE.IcosahedronGeometry(0.6, 3), m, 0, 1, 0);
  root.add(core);
  const shell = mesh(new THREE.IcosahedronGeometry(0.85, 1), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }), 0, 1, 0);
  root.add(shell);
  const light = new THREE.PointLight(color, 4, 10, 2);
  light.position.y = 1;
  root.add(light);
  return { root, tint: [m], base: 0, animate: (t) => { shell.rotation.y = t * 0.6; shell.rotation.x = t * 0.3; } };
}


function monolith(color: string): Built {
  const root = new THREE.Group();
  const m = std(color, { roughness: 0.25, metalness: 0.6, flatShading: false });
  root.add(mesh(new THREE.BoxGeometry(1.2, 6, 0.35), m, 0, 3, 0));
  const glyph = new THREE.MeshBasicMaterial({ color: '#7df9ff' });
  for (let i = 0; i < 9; i++) root.add(mesh(new THREE.BoxGeometry(0.06 + (i % 3) * 0.2, 0.05, 0.01), glyph, ((i * 37) % 5) * 0.12 - 0.25, 1 + i * 0.5, 0.18));
  return { root, tint: [m], base: 0, animate: (t) => { glyph.color.setHSL(0.5 + Math.sin(t) * 0.05, 1, 0.6 + Math.sin(t * 2) * 0.15); } };
}

function lantern(color: string): Built {
  const root = new THREE.Group();
  const iron = std('#2a2a30', { metalness: 0.6 });
  root.add(mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4), iron, 0, 1.2, 0));
  const glass = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3 });
  root.add(mesh(new THREE.BoxGeometry(0.35, 0.45, 0.35), glass, 0, 2.6, 0));
  root.add(mesh(new THREE.ConeGeometry(0.3, 0.25, 4), iron, 0, 2.95, 0).rotateY(Math.PI / 4));
  const l = new THREE.PointLight(color, 4, 10, 2);
  l.position.y = 2.6;
  root.add(l);
  return { root, tint: [glass], base: 0, animate: (t) => { l.intensity = 3.5 + Math.sin(t * 9) * 0.3 + Math.sin(t * 23) * 0.2; } };
}

function statue(color: string): Built {
  const root = new THREE.Group();
  const m = std(color, { roughness: 0.9 });
  root.add(mesh(new THREE.BoxGeometry(1.4, 0.6, 1.4), std('#77706a'), 0, 0.3, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.35, 0.55, 1.4, 8), m, 0, 1.3, 0));
  root.add(mesh(new THREE.SphereGeometry(0.28, 10, 8), m, 0, 2.25, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.1), m, 0.45, 1.6, 0).rotateZ(-0.9));
  root.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6), std('#c9a54a', { metalness: 0.8 }), 0.9, 2.1, 0));
  return { root, tint: [m], base: 0 };
}

function bridge(color: string): Built {
  const root = new THREE.Group();
  const wood = std(color);
  assets.applyTo(wood, 'weathered_planks', 1, .45); wood.color.set(color);
  for (let i = 0; i < 14; i++) {
    const u = i / 13 - 0.5;
    const p = mesh(new THREE.BoxGeometry(0.5, 0.12, 1.6), wood, u * 7, 0.6 + Math.cos(u * Math.PI) * 0.9, 0);
    p.rotation.z = -Math.sin(u * Math.PI) * 0.35;
    root.add(p);
  }
  return { root, tint: [wood], base: 0 };
}

export function buildObject(kind: ObjectKind, color: string): Built {
  switch (kind) {
    case 'castle': return castle(color);
    case 'floating_island': return floatingIsland(color);
    case 'sword': return sword(color);
    case 'crystal': return crystal(color);
    case 'tree': return tree(color);
    case 'tower': return tower(color);
    case 'orb': return orb(color);
    case 'dragon': return buildDragon(color);
    case 'monolith': return monolith(color);
    case 'lantern': return lantern(color);
    case 'statue': return statue(color);
    case 'bridge': return bridge(color);
  }
}
