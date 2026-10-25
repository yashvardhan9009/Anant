import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { Realm, InfoCard, FrameCtx } from '../engine/Realm';
import { makeSkyDome, makeMotes, Weather } from '../engine/fx';
import { obsidian, darkMetal, applyPBR } from '../engine/textures';
import { QUALITY } from '../engine/quality';
import type { WorldState, Env } from '../../shared/worldState';
import type { RealmId } from '../../shared/commands';

/** The Nexus: a monumental threshold floating in deep space. "Anant" means infinite — hence the ∞ of light. */
export class Nexus extends Realm {
  readonly id = 'nexus' as const;
  private sky = makeSkyDome(1200);
  private infinity = new THREE.Group();
  private coreMat!: THREE.ShaderMaterial;
  private stream!: THREE.Points;
  private curve!: THREE.CatmullRomCurve3;
  private floorMat!: THREE.ShaderMaterial;
  private shards!: THREE.InstancedMesh;
  private rings: THREE.Mesh[] = [];
  private motes = makeMotes(700, new THREE.Vector3(70, 30, 70), '#b6a8ff', 0.05);
  weather = new Weather();
  gates: THREE.Group[] = [];
  private amb = new THREE.HemisphereLight('#5a62b0', '#07050c', 0.35);
  private metal!: THREE.MeshStandardMaterial;
  bounds = 17.5;
  arrivalPitch = 0.16;

  protected build() {
    this.look = { exposure: 1.0, bloom: [0.55, 0.6, 0.82], contrast: 1.14, saturation: 1.02, shadows: '#08061a', highlights: '#eae4ff', vignette: 0.7, godRays: 0.4 };
    this.scene.fog = new THREE.FogExp2('#07061a', 0.006);
    const u = this.sky.uniforms;
    u.uTop.value.set('#010106'); u.uHorizon.value.set('#0c0a22'); u.uBottom.value.set('#010104');
    u.uNebA.value.set('#4a2aa8'); u.uNebB.value.set('#0e6a8a'); u.uNebula.value = 0.55; u.uBand.value = 0.7; u.uStars.value = 1.2;
    this.envSource = this.sky.mesh;
    this.scene.add(this.sky.mesh, this.motes, this.weather.points, this.amb);
    this.sunWorld = new THREE.Vector3(0, 10, -4);

    const key = new THREE.PointLight('#9a7bff', 60, 50, 2);
    key.position.set(0, 10, -4);
    const rimL = new THREE.SpotLight('#5ad8ff', 220, 90, 0.45, 0.6, 1.6);
    rimL.position.set(-30, 30, 20);
    rimL.castShadow = QUALITY.shadows;
    rimL.shadow.mapSize.set(1024, 1024);
    const warm = new THREE.SpotLight('#ffb27a', 120, 90, 0.5, 0.7, 1.6);
    warm.position.set(28, 22, -10);
    this.scene.add(key, rimL, warm);

    this.metal = applyPBR(new THREE.MeshStandardMaterial({ color: '#9a98a8', metalness: 0.92, roughness: 1 }), darkMetal(), 1, 0.6);

    // Polished obsidian floor: a true planar reflection under a glossy, veined stone layer.
    if (QUALITY.reflections) {
      const pr = Math.min(window.devicePixelRatio || 1, 1.5);
      const mirror = new Reflector(new THREE.CircleGeometry(18.4, 96), { textureWidth: Math.floor(innerWidth * pr * 0.6), textureHeight: Math.floor(innerHeight * pr * 0.6), color: 0x8a8a9a, clipBias: 0.003 });
      mirror.rotation.x = -Math.PI / 2;
      mirror.position.y = -0.02;
      this.scene.add(mirror);
    }
    const stone = applyPBR(new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.1, roughness: 1, transparent: true, opacity: QUALITY.reflections ? 0.72 : 1 }), obsidian(), 3, 0.4);
    const slab = new THREE.Mesh(new THREE.CircleGeometry(18.4, 96), stone);
    slab.rotation.x = -Math.PI / 2;
    slab.receiveShadow = true;
    this.scene.add(slab);
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vP;
        void main(){ float r = length(vP); float a = atan(vP.y, vP.x);
          float w = fwidth(r);
          float rings = smoothstep(0.5 - w*1.5, 0.5, abs(fract(r*0.25) - 0.5)) * smoothstep(17.0, 4.0, r);
          float pulse = smoothstep(1.2, 0.0, abs(r - mod(uTime*3.0, 22.0))) * 0.8;
          float spokes = smoothstep(0.497, 0.5, abs(fract(a*16.0/6.2831) - 0.5)) * smoothstep(5.0, 7.0, r) * smoothstep(18.0, 12.0, r);
          float inner = smoothstep(0.08, 0.0, abs(r - 3.0)) + smoothstep(0.05, 0.0, abs(r - 17.6))*1.5;
          vec3 col = vec3(0.45,0.35,1.0)*rings*(0.25 + pulse) + vec3(0.3,0.85,1.0)*(spokes*0.12 + inner*0.9);
          gl_FragColor = vec4(col, 1.0); }`,
    });
    const lines = new THREE.Mesh(new THREE.CircleGeometry(18.3, 128), this.floorMat);
    lines.rotation.x = -Math.PI / 2;
    lines.position.y = 0.01;
    this.scene.add(lines);
    // Platform rim & underside
    const rim = new THREE.Mesh(new THREE.TorusGeometry(18.45, 0.22, 16, 160), this.metal);
    rim.rotation.x = Math.PI / 2;
    const under = new THREE.Mesh(new THREE.CylinderGeometry(18.4, 4, 9, 96, 1, true), this.metal);
    under.position.y = -4.52;
    this.scene.add(rim, under);
    const undergl = new THREE.Mesh(new THREE.TorusGeometry(10, 0.08, 8, 128), new THREE.MeshBasicMaterial({ color: '#5ad8ff' }));
    undergl.rotation.x = Math.PI / 2;
    undergl.position.y = -6;
    this.scene.add(undergl);

    // ∞ — glass tube around a core of light, with particles streaming along it
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * Math.PI * 2;
      const d = 1 + Math.sin(t) ** 2;
      pts.push(new THREE.Vector3((5.4 * Math.cos(t)) / d, (5.4 * Math.sin(t) * Math.cos(t)) / d, Math.sin(t * 2) * 0.7));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, true);
    this.coreMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){ float f = fract(vUv.x*4.0 - uTime*0.2); vec3 a = vec3(0.45,0.95,1.0), b = vec3(0.75,0.45,1.0);
          vec3 c = mix(a, b, 0.5+0.5*sin(vUv.x*12.566 + uTime*0.7));
          float pulse = smoothstep(0.0, 0.05, f) * smoothstep(0.25, 0.05, f);
          gl_FragColor = vec4(c*(2.2 + pulse*5.0), 1.0); }`,
    });
    const core = new THREE.Mesh(new THREE.TubeGeometry(this.curve, 480, 0.045, 10, true), this.coreMat);
    const glass = new THREE.Mesh(
      new THREE.TubeGeometry(this.curve, 480, 0.2, 24, true),
      new THREE.MeshPhysicalMaterial({ color: '#c8d8ff', metalness: 0, roughness: 0.04, transparent: true, opacity: 0.22, clearcoat: 1, envMapIntensity: 2.5, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.infinity.add(core, glass);
    const N = 1600;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = Math.random();
    sg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.stream = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#bfe8ff', size: 0.06, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.stream.frustumCulled = false;
    this.infinity.add(this.stream);
    this.infinity.position.set(0, 10, -4);
    this.scene.add(this.infinity);
    // pedestal beneath the ∞
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, 0.6, 64), this.metal);
    ped.position.set(0, 0.3, -4);
    ped.castShadow = ped.receiveShadow = true;
    const pedGlow = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.03, 8, 96), new THREE.MeshBasicMaterial({ color: '#9a7bff' }));
    pedGlow.rotation.x = Math.PI / 2;
    pedGlow.position.set(0, 0.61, -4);
    this.scene.add(ped, pedGlow);

    // Colonnade fading into the void
    const colG = new THREE.CylinderGeometry(0.7, 0.9, 46, 12);
    const col = new THREE.InstancedMesh(colG, this.metal, 24);
    const strip = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 40, 0.08), new THREE.MeshBasicMaterial({ color: '#7a6bff' }), 24);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 34;
      m4.makeTranslation(Math.cos(a) * r, 10, Math.sin(a) * r);
      col.setMatrixAt(i, m4);
      m4.makeTranslation(Math.cos(a) * (r - 0.75), 10, Math.sin(a) * (r - 0.75));
      strip.setMatrixAt(i, m4);
    }
    col.castShadow = true;
    this.scene.add(col, strip);

    // Megastructure rings orbiting far away
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(120 + i * 70, 2.5 + i, 12, 200), this.metal);
      ring.rotation.set(1.2 + i * 0.35, i * 0.8, 0.3 * i);
      const band = new THREE.Mesh(new THREE.TorusGeometry(120 + i * 70, 0.35, 6, 300), new THREE.MeshBasicMaterial({ color: i === 1 ? '#ffb27a' : '#7df9ff', fog: false }));
      ring.add(band);
      band.position.z = 2 + i;
      this.rings.push(ring);
      this.scene.add(ring);
    }

    // Floating crystal shards (refractive look via physical material + env reflections)
    const shardGeo = new THREE.OctahedronGeometry(0.4, 0);
    shardGeo.scale(1, 2.6, 1);
    this.shards = new THREE.InstancedMesh(shardGeo, new THREE.MeshPhysicalMaterial({ color: '#c9bcff', metalness: 0.1, roughness: 0.05, clearcoat: 1, iridescence: 0.8, emissive: '#3a2a8a', emissiveIntensity: 0.4, envMapIntensity: 2 }), 60);
    this.shards.castShadow = true;
    this.scene.add(this.shards);

    // Three monumental gates
    const gateDefs: [RealmId, string, number, string][] = [
      ['atom', 'ENTER THE ATOM', -0.8, '#7df9ff'],
      ['cosmos', 'EXPLORE THE COSMOS', 0, '#ffd27d'],
      ['village', 'LIVING STORY · EMBERFALL', 0.8, '#ff9a6b'],
    ];
    for (const [realm, label, ang, color] of gateDefs) {
      const g = new THREE.Group();
      const a = ang - Math.PI / 2;
      g.position.set(Math.cos(a) * 13, 0, Math.sin(a) * 13);
      g.lookAt(0, 0, 0);
      // stepped plinth
      for (let i = 0; i < 3; i++) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(6.2 - i * 0.6, 0.25, 2.6 - i * 0.4), this.metal);
        st.position.y = 0.125 + i * 0.25;
        st.castShadow = st.receiveShadow = true;
        g.add(st);
      }
      // tapered obelisks with light inlays
      for (const s of [-1, 1]) {
        const og = new THREE.BoxGeometry(0.75, 9, 0.75, 1, 1, 1);
        const p = og.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < p.count; k++) if (p.getY(k) > 0) p.setXYZ(k, p.getX(k) * 0.6, p.getY(k), p.getZ(k) * 0.6);
        og.computeVertexNormals();
        const ob = new THREE.Mesh(og, this.metal);
        ob.position.set(s * 2.5, 5.25, 0);
        ob.castShadow = true;
        g.add(ob);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.33, 0.9, 4), this.metal);
        cap.rotation.y = Math.PI / 4;
        cap.position.set(s * 2.5, 10.2, 0);
        g.add(cap);
        const inlay = new THREE.Mesh(new THREE.BoxGeometry(0.05, 7.5, 0.02), new THREE.MeshBasicMaterial({ color }));
        inlay.position.set(s * 2.5, 5.2, 0.37);
        g.add(inlay);
      }
      // circular frame around the sigil
      const frame = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.16, 20, 96), this.metal);
      frame.position.y = 4.8;
      frame.castShadow = true;
      const glowRing = new THREE.Mesh(new THREE.TorusGeometry(1.86, 0.025, 8, 128), new THREE.MeshBasicMaterial({ color }));
      glowRing.position.y = 4.8;
      g.add(frame, glowRing);
      const sigil = this.makeSigil(realm, color);
      sigil.position.y = 4.8;
      g.add(sigil);
      const gl = new THREE.PointLight(color, 12, 12, 2);
      gl.position.set(0, 4.8, 1.2);
      g.add(gl);
      g.traverse((c) => (c.userData.gate = realm));
      const el = document.createElement('div');
      el.className = 'label gate-label';
      el.textContent = label;
      el.style.setProperty('--c', color);
      const lab = new CSS2DObject(el);
      lab.position.set(0, 11.4, 0);
      g.add(lab);
      this.gates.push(g);
      this.scene.add(g);
    }
  }

  private makeSigil(realm: RealmId, color: string) {
    const g = new THREE.Group();
    if (realm === 'atom') {
      // An icon in the classic style — the realm itself shows the true probability cloud.
      const nuc = new THREE.MeshPhysicalMaterial({ color: '#3a5cff', metalness: 0.6, roughness: 0.18, clearcoat: 1, envMapIntensity: 2.5 });
      for (let i = 0; i < 14; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), nuc);
        const u = (i * 2.399) % 6.28, v = Math.acos(1 - (2 * (i + 0.5)) / 14);
        s.position.set(Math.sin(v) * Math.cos(u) * 0.28, Math.cos(v) * 0.28, Math.sin(v) * Math.sin(u) * 0.28);
        g.add(s);
      }
      for (let i = 0; i < 3; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.018, 8, 128), new THREE.MeshBasicMaterial({ color: '#ffb066' }));
        r.scale.y = 0.42;
        r.rotation.set(Math.PI / 2, 0, (i * Math.PI) / 3);
        g.add(r);
      }
    } else if (realm === 'cosmos') {
      const planet = new THREE.Mesh(new THREE.SphereGeometry(0.75, 48, 32), new THREE.MeshPhysicalMaterial({ color: '#d9b38c', roughness: 0.6, clearcoat: 0.3, envMapIntensity: 1.5 }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.45, 96), new THREE.MeshStandardMaterial({ color: '#e8d6a8', side: THREE.DoubleSide, transparent: true, opacity: 0.75, roughness: 0.6 }));
      ring.rotation.x = 1.25;
      g.add(planet, ring);
    } else {
      const gold = new THREE.MeshStandardMaterial({ color: '#ffcf6a', metalness: 1, roughness: 0.2, envMapIntensity: 2 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.68, 0.4, 48, 1, true), gold);
      (band.material as THREE.Material).side = THREE.DoubleSide;
      g.add(band);
      for (let i = 0; i < 7; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.55, 12), gold);
        const a = (i / 7) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.72, 0.45, Math.sin(a) * 0.72);
        const gem = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshPhysicalMaterial({ color: '#ff3355', roughness: 0, transmission: 0, clearcoat: 1, emissive: '#550011' }));
        gem.position.set(Math.cos(a) * 0.76, 0.0, Math.sin(a) * 0.76);
        g.add(sp, gem);
      }
    }
    g.userData.spin = true;
    return g;
  }

  groundY() {
    return 0;
  }

  protected applyEnv(e: Env) {
    const u = this.sky.uniforms;
    u.uTintAmt.value = e.skyColor ? 0.55 : 0;
    if (e.skyColor) u.uTint.value.set(e.skyColor);
    u.uAurora.value = e.weather === 'aurora' ? 1 : 0;
    this.weather.set(e.weather);
    (this.scene.fog as THREE.FogExp2).density = 0.003 + e.fog * 0.025;
    const bright = e.timeOfDay === 'day' ? 1 : e.timeOfDay === 'dawn' ? 0.6 : 0.3;
    u.uHorizon.value.set(e.timeOfDay === 'day' ? '#2a2a6a' : e.timeOfDay === 'dawn' ? '#3a1e4a' : '#0c0a22');
    this.amb.intensity = 0.25 + bright * 0.5;
    this.envDirty = true;
  }

  update(ctx: FrameCtx) {
    super.update(ctx);
    const t = ctx.t;
    this.sky.uniforms.uTime.value = t;
    this.sky.uniforms.uLightning.value = this.weather.lightning;
    this.floorMat.uniforms.uTime.value = t;
    this.coreMat.uniforms.uTime.value = t;
    (this.motes.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    if (ctx.frozen) return;
    this.infinity.rotation.y = Math.sin(t * 0.15) * 0.5;
    this.infinity.position.y = 10 + Math.sin(t * 0.5) * 0.25;
    // particles flowing along the ∞
    const pos = this.stream.geometry.attributes.position as THREE.BufferAttribute;
    const seed = this.stream.geometry.attributes.seed as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const s = seed.getX(i);
      this.curve.getPointAt((s + t * 0.03 * (0.6 + s * 0.8)) % 1, v);
      const j = 0.25 * Math.sin(s * 900 + t);
      pos.setXYZ(i, v.x + j * Math.cos(s * 77), v.y + j * Math.sin(s * 51), v.z + j * Math.cos(s * 33));
    }
    pos.needsUpdate = true;
    for (const g of this.gates) g.children.forEach((c) => c.userData.spin && (c.rotation.y += ctx.dt * 0.4));
    this.rings.forEach((r, i) => (r.rotation.z += ctx.dt * 0.01 * (i % 2 ? -1 : 1)));
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.shards.count; i++) {
      const a = (i / this.shards.count) * Math.PI * 2 + t * 0.03 * (1 + (i % 3) * 0.3);
      const r = 21 + (i % 6) * 2.2;
      m.compose(new THREE.Vector3(Math.cos(a) * r, 4 + Math.sin(t * 0.4 + i) * 2.5 + (i % 5) * 3, Math.sin(a) * r), new THREE.Quaternion().setFromEuler(new THREE.Euler(t * 0.2 + i, t * 0.15 + i * 0.3, 0.3)), new THREE.Vector3(1, 1, 1).multiplyScalar(0.6 + (i % 4) * 0.25));
      this.shards.setMatrixAt(i, m);
    }
    this.shards.instanceMatrix.needsUpdate = true;
    this.weather.update(ctx.dt, ctx.camera.position, this.env?.gravity ?? 1, t);
  }

  info(s: WorldState): InfoCard {
    return {
      title: 'The Nexus',
      mode: 'THE THRESHOLD',
      subtitle: 'The space between realities. Choose a gate, draw a circle, or simply say where you want to go.',
      accuracy: [{ tag: 'ARTISTIC', text: 'The Nexus is an imaginative hub — nothing here depicts physical reality. (The atom gate uses the classic orbit icon; the realm itself shows the real probability cloud.)' }],
      stats: [
        { label: 'Objects here', value: String(s.objects.filter((o) => o.realm === 'nexus').length) },
        { label: 'Open portals', value: String(s.portals.filter((p) => p.from === 'nexus').length) },
        { label: 'Gravity', value: `${s.env.nexus.gravity}×` },
      ],
    };
  }
}
