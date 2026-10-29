import * as T from "three";
import { NOISE_GLSL } from "../engine/fx";
import { softSprite } from "../engine/textures";
import { QUALITY } from "../engine/quality";
import { Masonry, type NexusMaterials } from "./NexusCraft";

/** Local atmosphere: rising embers and low haze, rather than a screen-space veil. */
export class NexusAtmosphere {
  group = new T.Group();
  private clock = { value: 0 };
  private lights: T.PointLight[] = [];
  private debris: T.InstancedMesh;
  constructor(m: NexusMaterials) {
    this.group.name = "Nexus braziers, mist and suspended ruins";
    const b = new Masonry();
    const fire = new T.ShaderMaterial({
      uniforms: { uTime: this.clock },
      side: T.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader: `varying vec2 vUv;uniform float uTime;${NOISE_GLSL}
        void main(){vec2 p=vec2((vUv.x-.5)*2.,vUv.y);float n=fbm(vec3(p*5.-vec2(0.,uTime*2.7),3.));
          float width=(1.-p.y)*.73;float flame=1.-smoothstep(width-.12,width+.12,abs(p.x+(n-.5)*.28));
          flame*=(1.-smoothstep(.1,1.,p.y+n*.3))*smoothstep(0.,.12,p.y);vec3 col=mix(vec3(1.,.17,.018),vec3(1.,.8,.38),pow(1.-p.y,3.));
          gl_FragColor=vec4(col*2.4,flame*.8);}`,
    });
    const hearths = [
      [-30, 1],
      [-17, -5],
      [-4.7, -12],
      [4.7, -12],
      [17, -5],
      [30, 1],
      [-11, 14],
      [11, 14],
    ];
    for (const [x, z] of hearths) {
      b.add(new T.CylinderGeometry(0.7, 0.9, 0.3, 12), m.stone, [x, 0.15, z]);
      b.add(new T.CylinderGeometry(0.2, 0.45, 1.1, 12), m.iron, [x, 0.85, z]);
      b.add(new T.CylinderGeometry(0.75, 0.25, 0.4, 12, 1, true), m.bronze, [
        x,
        1.6,
        z,
      ]);
      for (let i = 0; i < 3; i++) {
        const mesh = new T.Mesh(new T.PlaneGeometry(1.15, 1.9), fire);
        mesh.position.set(x, 2.5, z);
        mesh.rotation.y = (i * Math.PI) / 3;
        this.group.add(mesh);
      }
      // Only the closer braziers need local illumination. Flames themselves stay emissive.
      if (Math.abs(x) > 10 && Math.abs(x) < 20) {
        const l = new T.PointLight("#ffb66b", 85, 15, 2);
        l.position.set(x, 2.6, z);
        this.lights.push(l);
        this.group.add(l);
      }
    }
    b.finish(this.group);
    const n = QUALITY.low ? 160 : 520,
      g = new T.BufferGeometry(),
      p = new Float32Array(n * 3),
      seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [x, z] = hearths[i % hearths.length];
      seed[i] = (i * 0.61803398875) % 1;
      p.set([x, 2, z], i * 3);
    }
    g.setAttribute("position", new T.BufferAttribute(p, 3));
    g.setAttribute("seed", new T.BufferAttribute(seed, 1));
    const ember = new T.Points(
      g,
      new T.ShaderMaterial({
        uniforms: { uTime: this.clock },
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        vertexShader: `attribute float seed;uniform float uTime;varying float alpha;void main(){float life=fract(seed+uTime*.17);vec3 p=position;p.y+=life*4.;p.x+=sin(seed*71.+life*4.)*life*.65;p.z+=cos(seed*91.+life*3.)*life*.5;vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=min(4.,70./-mv.z);alpha=(1.-life)*smoothstep(0.,.08,life);}`,
        fragmentShader:
          "varying float alpha;void main(){vec2 q=gl_PointCoord-.5;gl_FragColor=vec4(1.5,.65,.13,exp(-dot(q,q)*22.)*alpha);}",
      }),
    );
    ember.frustumCulled = false;
    this.group.add(ember);

    const hazeGeometry = new T.BufferGeometry(),
      hazeCount = QUALITY.low ? 20 : 70,
      hazePositions = new Float32Array(hazeCount * 3);
    for (let i = 0; i < hazeCount; i++) {
      const a = i * 2.399,
        r = 6 + ((i * 17) % 29);
      hazePositions.set(
        [Math.cos(a) * r, 0.5 + (i % 4) * 0.3, Math.sin(a) * r],
        i * 3,
      );
    }
    hazeGeometry.setAttribute(
      "position",
      new T.BufferAttribute(hazePositions, 3),
    );
    const haze = new T.Points(
      hazeGeometry,
      new T.PointsMaterial({
        map: softSprite(),
        size: 9,
        color: "#7186a4",
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
      }),
    );
    haze.name = "Low lying mist";
    this.group.add(haze);

    // Broken masonry, irregular instead of identical low-poly crystal confetti.
    const debrisGeo = new T.IcosahedronGeometry(0.6, 1);
    const vertices = debrisGeo.attributes.position as T.BufferAttribute;
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i),
        y = vertices.getY(i),
        z = vertices.getZ(i);
      const f = 0.8 + 0.25 * Math.sin(x * 37 + y * 29 + z * 41);
      vertices.setXYZ(i, x * f, y * f, z * f);
    }
    debrisGeo.computeVertexNormals();
    this.debris = new T.InstancedMesh(
      debrisGeo,
      m.stone,
      QUALITY.low ? 45 : 150,
    );
    this.debris.name = "Suspended weathered fragments";
    this.group.add(this.debris);
    const shaft = new T.Mesh(
      new T.CylinderGeometry(0.12, 0.05, 38, 12, 1, true),
      new T.ShaderMaterial({
        uniforms: { uTime: this.clock },
        side: T.DoubleSide,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        vertexShader:
          "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
        fragmentShader: `uniform float uTime;varying vec2 vUv;void main(){float flow=.45+.3*sin(vUv.y*170.-uTime*5.);gl_FragColor=vec4(.25,.5,1.3,flow*.3);}`,
      }),
    );
    shaft.position.set(0, 21, -16);
    this.group.add(shaft);
    this.update(0);
  }
  update(t: number) {
    this.clock.value = t;
    this.lights.forEach((l, i) => {
      l.intensity =
        80 + Math.sin(t * 7.7 + i) * 4 + Math.sin(t * 11.3 + i * 2) * 6;
    });
    const matrix = new T.Matrix4(),
      pos = new T.Vector3(),
      scale = new T.Vector3(),
      quat = new T.Quaternion(),
      euler = new T.Euler();
    for (let i = 0; i < this.debris.count; i++) {
      const a = i * 2.399 + t * 0.003,
        r = 28 + (i % 6) * 1.6;
      pos.set(
        Math.cos(a) * r,
        4 + (i % 13) * 2 + Math.sin(t * 0.22 + i) * 0.3,
        Math.sin(a) * r,
      );
      euler.set(i, t * 0.02 + i * 0.37, i * 0.6);
      quat.setFromEuler(euler);
      scale.set(
        0.3 + (i % 4) * 0.2,
        0.4 + (i % 3) * 0.3,
        0.25 + (i % 5) * 0.15,
      );
      matrix.compose(pos, quat, scale);
      this.debris.setMatrixAt(i, matrix);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }
}
