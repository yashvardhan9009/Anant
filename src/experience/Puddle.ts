import * as T from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";

/** A single planar reflection keeps the water connected to the actual scene. */
export class Puddle {
  mesh: Reflector;
  constructor() {
    const shape = new T.Shape();
    for (let i = 0; i <= 100; i++) {
      const a = (i / 100) * Math.PI * 2,
        r = 1 + Math.sin(a * 5) * 0.1 + Math.sin(a * 9 + 1) * 0.06;
      const x = Math.cos(a) * r,
        y = Math.sin(a) * r * 0.7;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    this.mesh = new Reflector(new T.ShapeGeometry(shape), {
      textureWidth: 512,
      textureHeight: 512,
      multisample: 0,
      clipBias: 0.003,
      color: 0x83a7b2,
      shader: {
        name: "Wet ground reflection",
        uniforms: {
          tDiffuse: { value: null },
          textureMatrix: { value: new T.Matrix4() },
          color: { value: new T.Color("#83a7b2") },
          time: { value: 0 },
        },
        vertexShader:
          "uniform mat4 textureMatrix;varying vec4 reflected;varying vec2 local;void main(){local=position.xy;reflected=textureMatrix*vec4(position,1.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
        fragmentShader:
          "uniform sampler2D tDiffuse;uniform vec3 color;uniform float time;varying vec4 reflected;varying vec2 local;void main(){vec4 uv=reflected;uv.xy+=vec2(sin(local.x*28.+time*.9)*cos(local.y*19.-time*.7),cos(local.y*24.+time*.8))*.0015*uv.w;vec3 reflection=texture2DProj(tDiffuse,uv).rgb;vec2 q=vec2(local.x,local.y/.7);float a=atan(q.y,q.x),r=1.+sin(a*5.)*.1+sin(a*9.+1.)*.06;float edge=1.-smoothstep(r-.16,r,length(q));gl_FragColor=vec4(mix(vec3(.025,.045,.052),reflection*color,.78),edge*.88);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
      },
    });
    // A separate layer captures nearby architecture and VFX. Distant foliage
    // uses the environment map, keeping planar reflections within a frame budget.
    this.mesh.camera.layers.set(1);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.036;
    (this.mesh.material as T.Material).transparent = true;
    (this.mesh.material as T.Material).depthWrite = false;
    // Transmission and the main pass can both ask for the same reflection.
    // Capture it once at a bounded rate, instead of recursively redrawing the
    // whole forest for every pass. Surface ripples still animate every frame.
    const capture = this.mesh.onBeforeRender;
    let lastCapture = -Infinity;
    this.mesh.onBeforeRender = (...args) => {
      const now = performance.now();
      if (now - lastCapture < 1000 / 24) return;
      lastCapture = now;
      capture.apply(this.mesh, args);
    };
  }
  update(t: number) {
    (this.mesh.material as T.ShaderMaterial).uniforms.time.value = t;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.getRenderTarget().dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as T.Material).dispose();
  }
}
