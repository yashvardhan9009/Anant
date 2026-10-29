import * as T from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { NOISE_GLSL } from "../engine/fx";
import { QUALITY } from "../engine/quality";
import { Masonry, type NexusMaterials } from "./NexusCraft";
import { NEXUS_GATES, GATE_STEPS, gateYaw } from "./nexusLayout";
import { assets } from "../engine/assets";
import { circularRaycast } from "../engine/aperture";

const time = () => ({ value: 0 });
const vertex = `varying vec2 vP; void main(){vP=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
// The portal vignettes are authored 3D scenery. Ray/plane clipping preserves
// their circular aperture when the observer moves, including in floor reflections.
function aperture(material: T.Material, frame: T.Group, radius: number) {
  const inverse = { value: new T.Matrix4() };
  frame.updateMatrixWorld(true);
  inverse.value.copy(frame.matrixWorld).invert();
  const previous = material.onBeforeCompile,
    previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.apertureInverse = inverse;
    shader.vertexShader =
      "varying vec3 apertureWorld;\n" +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        `apertureWorld=(modelMatrix*vec4(transformed,1.)).xyz;\n#include <project_vertex>`,
      );
    shader.fragmentShader =
      "uniform mat4 apertureInverse; varying vec3 apertureWorld;\n" +
      shader.fragmentShader.replace(
        "void main() {",
        `void main() {
      vec3 eye=(apertureInverse*vec4(cameraPosition,1.)).xyz;
      vec3 frag=(apertureInverse*vec4(apertureWorld,1.)).xyz;
      float k=eye.z/(eye.z-frag.z);
      vec2 hit=mix(eye.xy,frag.xy,k);
      if(eye.z<=0. || k<0. || length(hit)>${radius.toFixed(3)}) discard;`,
      );
  };
  material.customProgramCacheKey = () =>
    previousKey + "-nexus-aperture-" + radius;
  return material;
}

/** A star-filled, slowly moving field, not a screenshot of the destination. */
function starWindow(
  radius: number,
  color: string,
  kind: number,
  clock: { value: number },
) {
  return new T.Mesh(
    new T.PlaneGeometry(80, 80),
    new T.ShaderMaterial({
      uniforms: {
        uTime: clock,
        uColor: { value: new T.Color(color) },
        uKind: { value: kind },
      },
      side: T.DoubleSide,
      vertexShader: vertex,
      fragmentShader: `varying vec2 vP;uniform float uTime,uKind;uniform vec3 uColor;${NOISE_GLSL}
      void main(){vec2 p=vP/${radius.toFixed(2)};float r=length(p);float a=atan(p.y,p.x);
        float cloud=fbm(vec3(p*3.4,uTime*.018));float grain=fbm(vec3(p*15.,8.));
        vec3 col=vec3(.003,.006,.015)+uColor*(.025+.16*cloud*cloud)*(1.-r*.45);
        float dust=smoothstep(.33,.7,cloud)*grain;col+=mix(vec3(.045,.055,.12),uColor*.3,grain)*dust;
        vec2 grid=floor(p*230.);float star=hash(vec3(grid,uKind));vec2 sub=fract(p*230.)-.5;
        col+=smoothstep(.994,1.,star)*exp(-dot(sub,sub)*32.)*vec3(.65,.78,1.)*1.8;
        float rim=exp(-abs(r-.995)*190.);col+=uColor*rim*(1.8+grain);
        gl_FragColor=vec4(col,1.);
      }`,
    }),
  );
}

function castle(frame: T.Group, color: string, m: NexusMaterials) {
  const group = new T.Group();
  group.position.set(0, -1.8, -3);
  frame.add(group);
  const rock = aperture(m.stone.clone(), frame, 6.05);
  const edge = aperture(m.edge.clone(), frame, 6.05);
  const roof = aperture(m.iron.clone(), frame, 6.05);
  const windows = aperture(
    new T.MeshBasicMaterial({
      color: new T.Color("#ffd29b").multiplyScalar(2),
    }),
    frame,
    6.05,
  );
  void m.ready.then(() => {
    rock.copy(m.stone);
    edge.copy(m.edge);
    roof.copy(m.iron);
    rock.needsUpdate = edge.needsUpdate = roof.needsUpdate = true;
  });
  const b = new Masonry();
  // Floating buttressed citadel: walls, turrets, lancets, roof ridges and a suspended rocky base.
  const crag = new T.IcosahedronGeometry(1, 2),
    cp = crag.attributes.position as T.BufferAttribute;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i),
      y = cp.getY(i),
      z = cp.getZ(i),
      f = 0.8 + 0.23 * Math.sin(x * 19 + y * 13 + z * 21);
    cp.setXYZ(i, x * f * 3.8, Math.min(0.8, y * f * 2.8), z * f * 3.3);
  }
  crag.computeVertexNormals();
  b.add(crag, rock, [0, -0.7, -1]);
  b.add(new T.CylinderGeometry(3.7, 4.1, 0.7, 12), edge, [0, 0.4, -1]);
  b.box([4, 2.9, 3], rock, [0, 2, -1]);
  for (let side = -1; side <= 1; side += 2) {
    b.box([0.25, 3.1, 3.3], edge, [side * 1.85, 2, -1]);
    for (let i = 0; i < 5; i++) {
      const x = -1.5 + i * 0.75;
      b.box([0.2, 0.85, 0.05], windows, [x, 2.8, 0.53]);
      b.box([0.12, 2.5, 0.25], edge, [x + 0.25, 1.9, 0.62]);
      b.add(new T.ConeGeometry(0.18, 0.65, 4), roof, [x + 0.25, 3.45, 0.62]);
    }
    b.box([5.6, 0.2, 0.9], edge, [side * 1.8, 1.4, -1.8], [0, side * 0.25, 0]);
  }
  const towers: number[][] = [
    [-2.6, 3.5, -0.2],
    [2.6, 4.5, -0.3],
    [-1.5, 5.4, -2.4],
    [0.8, 6.3, -1.4],
    [0, 8.2, -2.7],
    [3, 2.9, -2.8],
    [-3, 2.7, -2.7],
  ];
  towers.forEach(([x, h, z], i) => {
    const r = i === 4 ? 0.65 : 0.45;
    b.add(new T.CylinderGeometry(r, r * 1.18, h, 8), rock, [
      x,
      h / 2 + 0.65,
      z,
    ]);
    b.add(new T.ConeGeometry(r * 1.55, 1.6 + (i % 2), 8), roof, [
      x,
      h + 1.45,
      z,
    ]);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      b.box(
        [0.09, 0.55, 0.025],
        windows,
        [x + Math.sin(a) * (r + 0.03), h - 0.3, z + Math.cos(a) * (r + 0.03)],
        [0, a, 0],
      );
      b.box(
        [0.18, h * 0.8, 0.22],
        edge,
        [x + Math.sin(a) * r, h * 0.4 + 0.5, z + Math.cos(a) * r],
        [0, a, 0],
      );
    }
  });
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    b.box(
      [0.32, 0.45, 0.42],
      rock,
      [Math.sin(a) * 3.7, 1.02, Math.cos(a) * 3.7 - 1],
      [0, a, 0],
    );
  }
  b.finish(group, "Portal citadel miniature");
  // Scanned surface geometry replaces the analytic underside close to the camera.
  void m.ready.then(async () => {
    const base = await assets.clone("boulder_01");
    if (base) {
      const box = new T.Box3().setFromObject(base),
        size = box.getSize(new T.Vector3()),
        center = box.getCenter(new T.Vector3());
      base.scale.set(7.8 / size.x, 3.8 / size.y, 5.8 / size.z);
      base.position.set(
        -center.x * base.scale.x,
        -1.3 - center.y * base.scale.y,
        -1 - center.z * base.scale.z,
      );
      base.traverse((o) => {
        if ((o as T.Mesh).isMesh) {
          const mesh = o as T.Mesh;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.raycast = () => {};
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map((source) =>
                aperture(source.clone(), frame, 6.05),
              )
            : aperture(mesh.material.clone(), frame, 6.05);
        }
      });
      base.name = "Scanned rock beneath the citadel";
      group.add(base);
    }
  });
  const light = new T.PointLight(color, 180, 20, 2);
  light.position.set(0, 6, 3);
  frame.add(light);
  return group;
}

function atom(frame: T.Group, clock: { value: number }) {
  const atom = new T.Group();
  atom.position.z = -1.8;
  frame.add(atom);
  const blue = aperture(
    new T.MeshStandardMaterial({
      color: "#68b6ff",
      emissive: "#17428d",
      emissiveIntensity: 0.7,
      metalness: 0.6,
      roughness: 0.2,
    }),
    frame,
    6.05,
  );
  for (let i = 0; i < 26; i++) {
    const a = i * 2.399,
      y = 1 - (i + 0.5) / 13,
      r = Math.sqrt(1 - y * y);
    const sphere = new T.Mesh(new T.SphereGeometry(0.28, 16, 12), blue);
    sphere.position.set(
      Math.cos(a) * r * 0.65,
      y * 0.65,
      Math.sin(a) * r * 0.65,
    );
    atom.add(sphere);
  }
  const line = aperture(
    new T.MeshBasicMaterial({
      color: new T.Color("#bddcfe").multiplyScalar(1.6),
      transparent: true,
      opacity: 0.7,
    }),
    frame,
    6.05,
  );
  for (let i = 0; i < 5; i++) {
    const orbit = new T.Mesh(
      new T.TorusGeometry(3.75 + i * 0.13, 0.016, 6, 192),
      line,
    );
    orbit.rotation.set(0.8 + i * 0.64, 0.4 + i * 0.7, i * 0.5);
    atom.add(orbit);
    const electron = new T.Mesh(new T.SphereGeometry(0.1, 12, 8), line);
    electron.position.x = 3.75 + i * 0.13;
    orbit.add(electron);
  }
  atom.userData.animate = (t: number) => {
    atom.rotation.y = t * 0.08;
    atom.rotation.z = Math.sin(t * 0.1) * 0.1;
  };
  return atom;
}

function gravity(frame: T.Group, clock: { value: number }) {
  const group = new T.Group();
  group.position.set(0, 0, -2);
  frame.add(group);
  const star = new T.Mesh(
    new T.SphereGeometry(0.9, 48, 32),
    aperture(
      new T.MeshBasicMaterial({
        color: new T.Color("#e1edff").multiplyScalar(2),
      }),
      frame,
      6.05,
    ),
  );
  group.add(star);
  const ringMaterial = aperture(
    new T.MeshStandardMaterial({
      color: "#8794b6",
      metalness: 0.8,
      roughness: 0.23,
      emissive: "#385578",
      emissiveIntensity: 0.3,
    }),
    frame,
    6.05,
  );
  for (let i = 0; i < 4; i++) {
    const ring = new T.Mesh(
      new T.TorusGeometry(2.1 + i * 0.6, 0.045, 8, 128),
      ringMaterial,
    );
    ring.rotation.set(1.05, i * 0.25, 0.2);
    group.add(ring);
    const planet = new T.Mesh(
      new T.SphereGeometry(0.18 + 0.04 * i, 20, 12),
      ringMaterial,
    );
    planet.position.x = 2.1 + i * 0.6;
    ring.add(planet);
    ring.userData.animate = (t: number) => {
      ring.rotation.z = t * (0.16 + i * 0.05);
    };
  }
  group.rotation.z = -0.25;
  return group;
}

function blackHole(frame: T.Group, clock: { value: number }) {
  // An artistic accretion/lensing vignette; the interactive Cosmos has the ray-integrated model.
  const disc = new T.Mesh(
    new T.CircleGeometry(5.9, 128),
    new T.ShaderMaterial({
      uniforms: {
        uTime: clock,
        inverseFrame: {
          value: new T.Matrix4().copy(frame.matrixWorld).invert(),
        },
      },
      vertexShader:
        "varying vec3 windowWorld;\n" +
        vertex.replace(
          "vP=position.xy;",
          "vP=position.xy;windowWorld=(modelMatrix*vec4(position,1.)).xyz;",
        ),
      transparent: true,
      depthWrite: false,
      fragmentShader: `varying vec3 windowWorld;uniform mat4 inverseFrame;varying vec2 vP; uniform float uTime;${NOISE_GLSL}
      void main(){vec3 eye=(inverseFrame*vec4(cameraPosition,1.)).xyz;vec3 frag=(inverseFrame*vec4(windowWorld,1.)).xyz;if(eye.z<=0.||length(mix(eye.xy,frag.xy,eye.z/(eye.z-frag.z)))>6.05)discard;
        vec2 p=vP/5.9;float r=length(p);float a=atan(p.y,p.x);vec2 d=vec2(p.x,p.y*3.8+.16*sin(p.x*3.));float dr=length(d);
        float turbulence=fbm(vec3(d*7.,uTime*.07));float disk=exp(-abs(dr-.59)*8.)*(.4+turbulence)*smoothstep(.25,.39,dr);
        float halo=exp(-abs(r-.28)*90.);float rear=exp(-abs(length(vec2(p.x,p.y*.9))-.4)*28.)*smoothstep(.05,.3,p.y);
        float streak=.65+.35*sin(dr*180.-a*6.+turbulence*10.-uTime*.4);
        vec3 col=vec3(1.,.45,.12)*disk*streak*1.7+vec3(1.,.73,.39)*(halo*2.+rear*.9);
        float shadow=1.-smoothstep(.245,.27,r);col*=1.-shadow;gl_FragColor=vec4(col,clamp(disk+halo+rear+shadow,0.,1.));
      }`,
    }),
  );
  disc.position.z = -0.25;
  disc.rotation.z = -0.3;
  frame.add(disc);
}

export class NexusWindows {
  gates: T.Group[] = [];
  infinity = new T.Group();
  clock = time();
  private animated: T.Object3D[] = [];
  constructor(scene: T.Scene, m: NexusMaterials) {
    for (const [id, title, x, z, color] of NEXUS_GATES) {
      const gate = new T.Group();
      gate.name = "Monumental gate · " + id;
      gate.userData.gate = id;
      gate.position.set(x, 0, z);
      gate.rotation.y = gateYaw(x, z);
      scene.add(gate);
      const b = new Masonry();
      for (const step of GATE_STEPS)
        b.box([step.width, 0.18, step.depth], m.stone, [
          0,
          step.height - 0.09,
          step.z,
        ]);
      for (const [r, thickness, depth, mat] of [
        [6.3, 0.29, 0.1, m.iron],
        [6.62, 0.18, 0.02, m.bronze],
        [6.86, 0.3, -0.15, m.edge],
        [7.15, 0.13, -0.1, m.iron],
      ] as const)
        b.add(new T.TorusGeometry(r, thickness, 12, 192), mat, [0, 8, depth]);
      for (let i = 0; i < 56; i++) {
        const a = ((i + 0.5) / 56) * Math.PI * 2;
        b.box(
          [0.66, 0.77, 1.2],
          m.stone,
          [Math.cos(a) * 7.14, 8 + Math.sin(a) * 7.14, -0.3],
          [0, 0, a],
        );
        b.box(
          [0.17, 0.62, 0.1],
          m.bronze,
          [Math.cos(a) * 7.15, 8 + Math.sin(a) * 7.15, 0.36],
          [0, 0, a],
        );
      }
      const emissive = new T.MeshBasicMaterial({
        color: new T.Color(color).multiplyScalar(1.7),
      });
      b.add(new T.TorusGeometry(6.06, 0.025, 8, 192), emissive, [0, 8, 0.16]);
      // Uneven lightning threads skim the aperture, with short branches on the rim.
      const veins: number[] = [];
      for (let i = 0; i < 240; i++) {
        const a = (i / 240) * Math.PI * 2,
          aa = ((i + 1) / 240) * Math.PI * 2,
          r = 6.08 + Math.sin(i * 7.13) * 0.07,
          rr = 6.08 + Math.sin((i + 1) * 7.13) * 0.07;
        veins.push(
          Math.cos(a) * r,
          8 + Math.sin(a) * r,
          0.25,
          Math.cos(aa) * rr,
          8 + Math.sin(aa) * rr,
          0.25,
        );
        if (i % 13 === 0)
          veins.push(
            Math.cos(a) * r,
            8 + Math.sin(a) * r,
            0.25,
            Math.cos(a + 0.026) * (r + 0.32),
            8 + Math.sin(a + 0.026) * (r + 0.32),
            0.27,
          );
      }
      const veinGeo = new T.BufferGeometry();
      veinGeo.setAttribute("position", new T.Float32BufferAttribute(veins, 3));
      gate.add(
        new T.LineSegments(
          veinGeo,
          new T.LineBasicMaterial({
            color: new T.Color(color).multiplyScalar(2.3),
            transparent: true,
            opacity: 0.65,
          }),
        ),
      );
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        b.box(
          [0.4, 0.075, 0.18],
          i % 6 ? m.bronze : m.edge,
          [Math.cos(a) * 6.54, 8 + Math.sin(a) * 6.54, 0.39],
          [0, 0, a],
        );
        if (i % 3 === 0) {
          b.box(
            [0.28, 0.12, 0.54],
            m.iron,
            [Math.cos(a) * 6.96, 8 + Math.sin(a) * 6.96, 0.12],
            [0, 0, a],
          );
          b.add(new T.SphereGeometry(0.07, 6, 4), m.bronze, [
            Math.cos(a) * 6.98,
            8 + Math.sin(a) * 6.98,
            0.48,
          ]);
        }
      }
      for (const side of [-1, 1]) {
        b.box([1.25, 17, 1.85], m.stone, [side * 7.6, 8.5, -0.4]);
        b.add(
          new T.ConeGeometry(0.68, 3.5, 4),
          m.iron,
          [side * 7.6, 18.6, -0.4],
          [0, Math.PI / 4, 0],
        );
        for (const k of [-0.4, 0.4])
          b.box([0.08, 15.8, 0.14], m.bronze, [side * 7.6 + k, 8.6, 0.58]);
        for (const y of [1.1, 2, 14.9, 16.8])
          b.box([1.65, 0.2, 2.2], m.edge, [side * 7.6, y, -0.4]);
      }
      b.finish(gate, "Layered portal stone and bronze");
      const apertureFrame = new T.Group();
      apertureFrame.position.y = 8;
      apertureFrame.userData.skipContactAO = true;
      gate.add(apertureFrame);
      scene.updateMatrixWorld(true);
      const sky = starWindow(6.05, color, this.gates.length, this.clock);
      sky.position.z = -8;
      apertureFrame.add(sky);
      // Clip the background as well, because it lies behind the aperture.
      const skyMat = sky.material;
      const originalVertex = skyMat.vertexShader;
      skyMat.uniforms.inverseFrame = {
        value: new T.Matrix4().copy(apertureFrame.matrixWorld).invert(),
      };
      skyMat.vertexShader =
        "varying vec3 windowWorld;\n" +
        originalVertex.replace(
          "vP=position.xy;",
          "vP=position.xy;windowWorld=(modelMatrix*vec4(position,1.)).xyz;",
        );
      skyMat.fragmentShader =
        "uniform mat4 inverseFrame;varying vec3 windowWorld;\n" +
        skyMat.fragmentShader.replace(
          "void main(){",
          "void main(){vec3 e=(inverseFrame*vec4(cameraPosition,1.)).xyz;vec3 f=(inverseFrame*vec4(windowWorld,1.)).xyz;vec2 hit=mix(e.xy,f.xy,e.z/(e.z-f.z));if(e.z<=0.||length(hit)>6.05)discard;",
        );
      skyMat.fragmentShader = skyMat.fragmentShader.replace(
        "vec2 p=vP/6.05;",
        "vec2 p=hit/6.05;",
      );
      if (id === "atom") atom(apertureFrame, this.clock);
      else if (id === "heavy") gravity(apertureFrame, this.clock);
      else if (id === "village") castle(apertureFrame, color, m);
      else blackHole(apertureFrame, this.clock);
      apertureFrame.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
        o.raycast = () => {};
      });
      // Raycasting must obey the visible circular opening, not the large sky plane.
      const hitArea = new T.Mesh(
        new T.CircleGeometry(6.05, 64),
        new T.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        }),
      );
      hitArea.name = "Circular destination hit area";
      circularRaycast(hitArea, 6.05);
      apertureFrame.add(hitArea);
      gate.userData.portalAnchor = new T.Vector3(0, 2.6, 5.2);
      const light = new T.PointLight(color, 240, 22, 2);
      light.position.set(0, 6, 3);
      gate.add(light);
      const el = document.createElement("div");
      el.className = "label gate-label";
      el.textContent = title;
      el.style.setProperty("--c", color);
      const label = new CSS2DObject(el);
      label.position.set(0, 16.1, 0.2);
      gate.add(label);
      this.gates.push(gate);
    }
    this.buildInfinity(m);
    scene.add(this.infinity);
    scene.traverse((o) => {
      if (o.userData.animate) this.animated.push(o);
    });
  }

  private buildInfinity(m: NexusMaterials) {
    this.infinity.name = "Celestial infinity astrolabe";
    this.infinity.position.set(0, 22.5, -16);
    for (const side of [-1, 1]) {
      const loop = new T.Group();
      loop.position.x = side * 7.15;
      loop.rotation.z = side * 0.31;
      this.infinity.add(loop);
      const curve = new T.EllipseCurve(
        0,
        0,
        8.15,
        4.15,
        0,
        Math.PI * 2,
        false,
        0,
      );
      const path = new T.CatmullRomCurve3(
        curve.getPoints(192).map((p) => new T.Vector3(p.x, p.y, 0)),
        true,
      );
      const b = new Masonry();
      for (const [z, r, mat] of [
        [-0.24, 0.32, m.iron],
        [0.12, 0.12, m.bronze],
        [-0.5, 0.15, m.edge],
      ] as const)
        b.add(new T.TubeGeometry(path, 192, r, 12, true), mat, [0, 0, z]);
      for (let i = 0; i < 64; i++) {
        const f = i / 64,
          p = path.getPointAt(f),
          t = path.getTangentAt(f);
        b.box([0.38, 0.18, 0.42], i % 4 ? m.iron : m.bronze, p.toArray(), [
          0,
          0,
          Math.atan2(t.y, t.x),
        ]);
      }
      b.finish(loop, "Engraved infinity housing");
      const galaxy = new T.Mesh(
        new T.CircleGeometry(1, 128),
        new T.ShaderMaterial({
          uniforms: { uTime: this.clock, uSide: { value: side } },
          vertexShader: vertex,
          fragmentShader: `varying vec2 vP;uniform float uTime,uSide;${NOISE_GLSL}
          void main(){vec2 p=vP;float r=length(p);float a=atan(p.y,p.x)+uTime*.009*uSide;float n=fbm(vec3(p*9.,3.));
            float arms=pow(.5+.5*cos(a*2.+log(r+.035)*5.8+n*2.2),4.);float density=exp(-r*3.8);
            vec3 col=vec3(.009,.018,.045)+vec3(.19,.29,.69)*arms*density*(.3+n)*1.3;
            col+=vec3(.9,.64,.43)*exp(-r*r*110.)*2.;col+=vec3(.26,.37,.68)*exp(-abs(r-.96)*65.)*(.35+n);
            vec2 cell=floor(p*300.);float star=hash(vec3(cell,uSide));vec2 q=fract(p*300.)-.5;
            col+=smoothstep(.993,1.,star)*exp(-dot(q,q)*45.)*(.6+arms)*vec3(.7,.82,1.4);
            col*=1.-smoothstep(.96,1.,r);gl_FragColor=vec4(col,1.);
          }`,
        }),
      );
      galaxy.scale.set(7.96, 3.96, 1);
      galaxy.position.z = -0.35;
      loop.add(galaxy);
      // Thousands of individually placed stars give the arms depth, parallax and
      // fine structure. The surface underneath carries the unresolved dust.
      const count = QUALITY.low ? 1000 : 6500,
        positions = new Float32Array(count * 3),
        colours = new Float32Array(count * 3),
        c = new T.Color();
      const random = (i: number, k: number) => {
        const n = Math.sin(i * 127.1 + k * 311.7 + side * 17.1) * 43758.5453;
        return n - Math.floor(n);
      };
      for (let i = 0; i < count; i++) {
        const r = Math.pow(random(i, 1), 0.7) * 0.94,
          spread = (random(i, 3) - 0.5) * (1.8 + r * 0.5),
          a =
            (i % 2) * Math.PI -
            Math.log(r + 0.035) * 2.9 +
            spread +
            (i % 5 === 0 ? random(i, 8) * Math.PI * 2 : 0);
        positions.set(
          [
            Math.cos(a) * r * 7.96,
            Math.sin(a) * r * 3.96,
            -0.2 + (random(i, 4) - 0.5) * 0.35,
          ],
          i * 3,
        );
        c.set(
          r < 0.2 ? "#ffddaf" : random(i, 6) > 0.25 ? "#9fbaff" : "#fff2e0",
        ).multiplyScalar(0.5 + random(i, 7) * 1.6);
        colours.set(c.toArray(), i * 3);
      }
      const stars = new T.BufferGeometry();
      stars.setAttribute("position", new T.BufferAttribute(positions, 3));
      stars.setAttribute("color", new T.BufferAttribute(colours, 3));
      loop.add(
        new T.Points(
          stars,
          new T.PointsMaterial({
            size: 0.012,
            vertexColors: true,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: T.AdditiveBlending,
          }),
        ),
      );
      const edge = new T.Mesh(
        new T.TubeGeometry(path, 192, 0.023, 6, true),
        new T.MeshBasicMaterial({
          color: new T.Color("#9cc7ff").multiplyScalar(1.7),
        }),
      );
      edge.position.z = 0.06;
      loop.add(edge);
    }
    const crystal = new T.Mesh(
      new T.OctahedronGeometry(1.6),
      new T.MeshPhysicalMaterial({
        color: "#a6cbff",
        metalness: 0.28,
        roughness: 0.09,
        clearcoat: 1,
        transparent: true,
        opacity: 0.45,
        emissive: "#2a538a",
        emissiveIntensity: 0.4,
        depthWrite: false,
      }),
    );
    crystal.scale.set(0.52, 1.7, 0.52);
    crystal.name = "Suspended faceted heart";
    const edges = new T.LineSegments(
      new T.EdgesGeometry(crystal.geometry),
      new T.LineBasicMaterial({
        color: new T.Color("#b6d8ff").multiplyScalar(2),
      }),
    );
    crystal.add(edges);
    crystal.userData.animate = (t: number) => {
      crystal.rotation.y = t * 0.14;
    };
    this.infinity.add(crystal);
  }
  update(t: number) {
    this.clock.value = t;
    for (const o of this.animated) o.userData.animate(t);
  }
}
