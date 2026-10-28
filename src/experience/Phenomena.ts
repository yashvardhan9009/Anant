import * as T from "three";
import type { ScenePlan } from "../../shared/experience";

const noise = `float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);} float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);} float fb(vec3 p){return noise(p)*.65+noise(p*2.13)*.25+noise(p*4.27)*.1;}`;

/** Bounded GPU effects. These are real-time visual approximations, not fluid solvers. */
export class Phenomenon {
  root = new T.Group();
  private flight?: { from: T.Vector3; to: T.Vector3; t: number };
  private animators: ((t: number, dt: number, camera: T.Camera) => void)[] = [];
  constructor(public spec: ScenePlan["effects"][number]) {
    this.root.position.fromArray(spec.position);
    this.root.scale.setScalar(spec.size);
    const kind = spec.kind;
    if (kind === "fire" || kind === "steam") this.volume(kind === "steam");
    else if (kind === "water") this.water();
    else if (kind === "ice") this.ice();
    else if (kind === "lightning") this.lightning();
    else if (kind === "portal") this.portal();
    else this.particles(kind === "vortex");
  }
  private volume(steam: boolean) {
    const uniforms = {
      time: { value: 0 },
      eye: { value: new T.Vector3() },
      steam: { value: steam ? 1 : 0 },
      tint: { value: new T.Color(this.spec.color) },
    };
    const material = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: T.BackSide,
      vertexShader:
        "varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader: `varying vec3 p;uniform vec3 eye,tint;uniform float time,steam;${noise}
      void main(){vec3 rd=normalize(p-eye);vec3 inv=1./rd;vec3 a=(-.5-eye)*inv,b=(.5-eye)*inv;vec3 lo=min(a,b),hi=max(a,b);float near=max(max(lo.x,lo.y),lo.z),far=min(min(hi.x,hi.y),hi.z);near=max(0.,near);if(far<=near)discard;float stepSize=(far-near)/32.;vec4 sum=vec4(0.);
      for(int i=0;i<32;i++){vec3 q=eye+rd*(near+(float(i)+.5)*stepSize);float h=q.y+.5;
      vec3 curl=vec3(sin(h*11.-time*3.1)+sin(h*19.+time*1.7)*.35,0.,cos(h*9.+time*2.3))*.095*h;
      float n=fb(q*vec3(11.,7.,11.)+curl*2.+vec3(0.,-time*(steam>.5?.35:1.8),0.));
      float width=mix(.36,.015,pow(h,.75));vec2 flow=q.xz+curl.xz;
      float radial=min(length(flow-vec2(.13*(1.-h),.02)),min(length(flow+vec2(.12*(1.-h),.08)),length(flow-vec2(.02,-.12*(1.-h)))));
      float density=(1.-smoothstep(width-.075,width,radial+(n-.5)*.32))*smoothstep(0.,.045,h)*(1.-smoothstep(.7,1.,h));
      density*=smoothstep(.22,.6,n+(.65-h)*.32)*1.65;
      if(steam>.5)density=(1.-smoothstep(.05,.5,radial))*n*(1.-h)*.65;
      float heat=clamp(1.-h*.9-radial*1.4+(n-.5)*.5,0.,1.);vec3 col=mix(vec3(.55,.025,.003),mix(tint*2.4,vec3(4.,2.9,1.15),smoothstep(.4,1.,heat)),heat);if(steam>.5)col=mix(vec3(.15,.22,.26),tint,n);float alpha=1.-exp(-density*stepSize*(steam>.5?4.:10.));sum.rgb+=(1.-sum.a)*col*alpha;sum.a+=(1.-sum.a)*alpha;}
      if(sum.a<.002)discard;gl_FragColor=vec4(sum.rgb/max(.001,sum.a),sum.a);}`,
    });
    const mesh = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
    mesh.scale.set(2, steam ? 4.5 : 3.6, 2);
    mesh.position.y = mesh.scale.y / 2;
    this.root.add(mesh);
    const inverse = new T.Matrix4();
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      mesh.updateWorldMatrix(true, false);
      uniforms.eye.value
        .setFromMatrixPosition(camera.matrixWorld)
        .applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
    };
    this.animators.push((t, dt, camera) => {
      uniforms.time.value = t;
      mesh.updateWorldMatrix(true, false);
      uniforms.eye.value
        .copy(camera.position)
        .applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
    });
    if (!steam) {
      const light = new T.PointLight("#ff933f", 75, 22, 2);
      light.position.y = 1;
      this.root.add(light);
      this.animators.push((t) => {
        light.intensity = 72 + 12 * Math.sin(t * 11) + 6 * Math.sin(t * 23);
      });
      this.particles(false, true);
      this.smoke();
    }
  }
  private smoke() {
    const count = 20,
      positions = new Float32Array(count * 3),
      lives = new Float32Array(count);
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
    geometry.setAttribute("life", new T.BufferAttribute(lives, 1));
    const uniforms = { time: { value: 0 }, scale: { value: this.spec.size } };
    const material = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `attribute float life;varying float age;uniform float scale;void main(){age=life;vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp((.4+life*2.8)*scale*520./max(1.,-p.z),2.,170.);gl_Position=projectionMatrix*p;}`,
      fragmentShader: `varying float age;uniform float time;${noise}void main(){vec2 uv=gl_PointCoord-.5;float r=length(uv)*2.;float n=fb(vec3(uv*5.+age,time*.12+age*5.));float density=(1.-smoothstep(.3,1.,r+n*.25))*smoothstep(.2,.75,n);float alpha=density*sin(age*3.14159)*.22;gl_FragColor=vec4(mix(vec3(.14,.15,.16),vec3(.38,.35,.3),1.-age),alpha);}`,
    });
    const smoke = new T.Points(geometry, material);
    smoke.frustumCulled = false;
    this.root.add(smoke);
    this.animators.push((t) => {
      uniforms.time.value = t;
      for (let i = 0; i < count; i++) {
        const age = (i / count + t * 0.085) % 1;
        lives[i] = age;
        const swirl = i * 2.399 + t * 0.4;
        positions.set(
          [
            Math.sin(swirl) * (0.15 + age * 0.6) + age * age * 1.4,
            1.6 + age * 5.5,
            Math.cos(swirl) * (0.12 + age * 0.5),
          ],
          i * 3,
        );
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.life.needsUpdate = true;
    });
  }
  private water() {
    const causticLight = new T.PointLight(this.spec.color, 7, 9, 2);
    causticLight.position.y = 0.8;
    this.root.add(causticLight);
    const material = new T.MeshPhysicalMaterial({
      color: this.spec.color,
      metalness: 0.1,
      roughness: 0.07,
      transmission: 0.72,
      thickness: 1.7,
      ior: 1.333,
      clearcoat: 1,
      envMapIntensity: 2,
    });
    const clock = { value: 0 };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.waveTime = clock;
      shader.vertexShader =
        "uniform float waveTime;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n transformed += normal * (sin(position.x*7.+waveTime*2.)*sin(position.y*6.-waveTime*1.4)*.08 + sin(position.z*12.+waveTime)*.025);",
        );
    };
    const mesh = new T.Mesh(new T.SphereGeometry(0.85, 48, 32), material);
    mesh.position.y = 1.4;
    this.root.add(mesh);
    const ring = new T.Mesh(
      new T.TorusGeometry(1.15, 0.055, 10, 80),
      material.clone(),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    this.root.add(ring);
    const curve = new T.CatmullRomCurve3(
      Array.from({ length: 120 }, (_, i) => {
        const f = i / 119,
          a = f * Math.PI * 4;
        return new T.Vector3(
          Math.cos(a) * (1.1 - f * 0.3),
          0.15 + f * 2.6,
          Math.sin(a) * (1.1 - f * 0.3),
        );
      }),
    );
    const stream = new T.Mesh(
      new T.TubeGeometry(curve, 120, 0.055, 8, false),
      material,
    );
    this.root.add(stream);
    this.animators.push((t) => (stream.rotation.y = t * 0.7));
    const drops = new T.InstancedMesh(
      new T.SphereGeometry(0.014, 7, 5),
      material,
      100,
    );
    this.root.add(drops);
    const dummy = new T.Object3D();
    this.animators.push((t) => {
      clock.value = t;
      mesh.position.y = 1.4 + Math.sin(t * 0.9) * 0.16;
      ring.scale.setScalar(1 + Math.sin(t * 1.8) * 0.15);
      for (let i = 0; i < 100; i++) {
        const a = i * 0.7 + t * 0.8,
          h = (i / 100 + t * 0.13) % 1;
        dummy.position.set(
          Math.cos(a) * (1 - h * 0.4),
          0.15 + h * 2.7,
          Math.sin(a) * (1 - h * 0.4),
        );
        dummy.scale.set(0.7, 1.5, 0.7);
        dummy.updateMatrix();
        drops.setMatrixAt(i, dummy.matrix);
      }
      drops.instanceMatrix.needsUpdate = true;
    });
  }
  private ice() {
    const mat = new T.MeshPhysicalMaterial({
      color: this.spec.color,
      metalness: 0.1,
      roughness: 0.16,
      transmission: 0.4,
      thickness: 2,
      ior: 1.31,
      clearcoat: 1,
    });
    for (let i = 0; i < 9; i++) {
      const m = new T.Mesh(new T.ConeGeometry(0.3, 2.5, 6), mat);
      m.position.set(
        Math.sin(i * 2.4) * 0.65,
        1 + Math.sin(i) * 0.3,
        Math.cos(i * 2.4) * 0.65,
      );
      m.rotation.set(Math.sin(i) * 0.3, i, Math.cos(i) * 0.3);
      this.root.add(m);
    }
  }
  private lightning() {
    const geometry = new T.BufferGeometry(),
      positions = new Float32Array(42 * 3);
    geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
    const line = new T.Line(
      geometry,
      new T.LineBasicMaterial({
        color: this.spec.color,
        transparent: true,
        opacity: 0.95,
      }),
    );
    this.root.add(line);
    const light = new T.PointLight(this.spec.color, 0, 25);
    light.position.y = 3;
    this.root.add(light);
    this.animators.push((t) => {
      const pulse = Math.pow(Math.max(0, Math.sin(t * 2.3)), 18);
      line.visible = pulse > 0.03;
      light.intensity = pulse * 70;
      for (let i = 0; i < 42; i++) {
        const f = i / 41;
        positions.set(
          [
            Math.sin(i * 15.7 + Math.floor(t * 12)) *
              0.25 *
              Math.sin(f * Math.PI),
            f * 9,
            Math.cos(i * 7.3 + t * 9) * 0.17,
          ],
          i * 3,
        );
      }
      geometry.attributes.position.needsUpdate = true;
    });
  }
  private portal() {
    const material = new T.MeshStandardMaterial({
      color: this.spec.color,
      emissive: this.spec.color,
      emissiveIntensity: 3,
      metalness: 0.7,
      roughness: 0.2,
    });
    const ring = new T.Mesh(new T.TorusGeometry(1.3, 0.045, 10, 120), material);
    ring.position.y = 1.55;
    this.root.add(ring);
    const core = new T.Mesh(
      new T.CircleGeometry(1.27, 64),
      new T.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          tint: { value: new T.Color(this.spec.color) },
        },
        transparent: true,
        side: T.DoubleSide,
        depthWrite: false,
        vertexShader:
          "varying vec2 uv0;void main(){uv0=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
        fragmentShader: `varying vec2 uv0;uniform float time;uniform vec3 tint;${noise}void main(){vec2 p=uv0-.5;float r=length(p),a=atan(p.y,p.x);float n=fb(vec3(p*9.,time*.2));float spiral=sin(a*4.+r*34.-time*2.+n*3.)*.5+.5;gl_FragColor=vec4(tint*(.2+spiral*.6)+vec3(.6,.8,1.)*pow(r*2.,8.),.92);}`,
      }),
    );
    core.position.y = 1.55;
    this.root.add(core);
    this.animators.push((t) => {
      core.material.uniforms.time.value = t;
      ring.rotation.z = t * 0.12;
    });
  }
  private particles(vortex: boolean, embers = false) {
    const n = vortex ? 750 : embers ? 160 : 240,
      positions = new Float32Array(n * 3),
      seeds = Array.from(
        { length: n },
        (_, i) => (((Math.sin(i * 127.1) * 43758.5) % 1) + 1) % 1,
      );
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
    const material = new T.ShaderMaterial({
      uniforms: {
        tint: { value: new T.Color(embers ? "#ffb74a" : this.spec.color) },
        pointSize: { value: embers ? 25 : vortex ? 24 : 18 },
      },
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        "uniform float pointSize;void main(){vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(pointSize/max(1.,-p.z),1.,12.);gl_Position=projectionMatrix*p;}",
      fragmentShader:
        "uniform vec3 tint;void main(){float r=length(gl_PointCoord-.5)*2.;float a=exp(-r*r*4.)*(1.-smoothstep(.7,1.,r));gl_FragColor=vec4(tint*2.,a*.7);}",
    });
    const points = new T.Points(geometry, material);
    points.frustumCulled = false;
    this.root.add(points);
    this.animators.push((t) => {
      for (let i = 0; i < n; i++) {
        const s = seeds[i],
          f = (s + t * (embers ? 0.12 : 0.045)) % 1,
          a = i * 2.4 + t * (vortex ? 2 : 0.2),
          r = vortex ? 0.2 + f * 1.5 : embers ? 0.2 + f * 0.6 : 1.4 * s;
        positions.set(
          [
            Math.cos(a) * r,
            f * (vortex ? 5 : embers ? 4 : 1.5),
            Math.sin(a) * r,
          ],
          i * 3,
        );
      }
      geometry.attributes.position.needsUpdate = true;
    });
  }
  update(t: number, dt: number, camera: T.Camera) {
    if (this.flight) {
      const f = this.flight,
        u = Math.min(1, (f.t += dt) / 0.65),
        k = u * u * (3 - 2 * u);
      this.root.position.lerpVectors(f.from, f.to, k);
      this.root.position.y += Math.sin(u * Math.PI) * 0.8;
      this.root.scale.setScalar(this.spec.size * (0.2 + 0.8 * k));
      if (u === 1) this.flight = undefined;
    }
    for (const f of this.animators) f(t, dt, camera);
  }
  launch(from: T.Vector3) {
    this.flight = {
      from: from.clone(),
      to: new T.Vector3(...this.spec.position),
      t: 0,
    };
    this.root.position.copy(from);
    this.root.scale.setScalar(this.spec.size * 0.2);
  }
  dispose() {
    this.root.traverse((o) => {
      if (o instanceof T.Mesh || o instanceof T.Points || o instanceof T.Line) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          m.dispose();
      }
    });
    this.root.removeFromParent();
  }
}
