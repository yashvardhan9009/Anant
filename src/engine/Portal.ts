/**
 * Portals: a live window into another realm.
 *
 * The destination realm is rendered every frame into a render target from a
 * "portal camera" whose pose mirrors the user's camera relative to the portal:
 *     M_portalCam = M_exit · R_y(π) · M_entrance⁻¹ · M_camera
 * The portal disc samples that texture in screen space, so the view has correct
 * perspective and parallax as you move — it is not a video or a static image.
 */
import * as THREE from 'three';
import type { Portal } from '../../shared/worldState';
import { NOISE_GLSL } from './fx';

export const PORTAL_RADIUS = 2.1;

const REALM_COLORS: Record<string, string> = { nexus: '#b388ff', atom: '#7df9ff', cosmos: '#ffd27d', village: '#ff9a6b' };

export class PortalView {
  group = new THREE.Group();
  disc: THREE.Mesh;
  rim: THREE.Mesh;
  rt: THREE.WebGLRenderTarget;
  discMat: THREE.ShaderMaterial;
  rimMat: THREE.ShaderMaterial;
  open = 0;
  prevSide = 1;
  state: Portal;
  light: THREE.PointLight;
  vortex: THREE.Points;
  vortexMat: THREE.ShaderMaterial;

  constructor(p: Portal, w: number, h: number) {
    this.state = p;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace });
    const color = new THREE.Color(REALM_COLORS[p.to] ?? '#ffffff');
    this.discMat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: this.rt.texture }, uRes: { value: new THREE.Vector2(w, h) }, uTime: { value: 0 }, uOpen: { value: 0 }, uColor: { value: color } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `uniform sampler2D tView; uniform vec2 uRes; uniform float uTime, uOpen; uniform vec3 uColor; varying vec2 vUv;
        ${NOISE_GLSL}
        void main(){
          vec2 c = vUv - 0.5; float r = length(c)*2.0;
          if (r > uOpen) discard;
          vec2 suv = gl_FragCoord.xy / uRes;
          // ripple near the edge
          float edge = smoothstep(0.55, 1.0, r/uOpen);
          float n = fbm(vec3(c*6.0, uTime*0.6));
          suv += normalize(c+1e-5) * edge * (n-0.5) * 0.04;
          // refraction: the view bends slightly toward the rim, with a chromatic fringe
          vec2 bend = normalize(c+1e-5) * pow(r/uOpen, 4.0) * 0.025;
          vec3 col = vec3(texture2D(tView, suv - bend*1.2).r, texture2D(tView, suv - bend).g, texture2D(tView, suv - bend*0.8).b);
          col *= 0.85 + 0.15*smoothstep(1.0, 0.3, r/uOpen);
          col += uColor * pow(r/uOpen, 10.0) * 3.0;
          col = mix(col, uColor*2.0, edge*edge*0.35);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(PORTAL_RADIUS, 64), this.discMat);
    this.rimMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpen: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `uniform float uTime, uOpen; uniform vec3 uColor; varying vec2 vUv; ${NOISE_GLSL}
        void main(){
          float a = vUv.x * 6.2831; float n = fbm(vec3(cos(a)*2.0, sin(a)*2.0, uTime*0.8 + vUv.y*2.0));
          float band = smoothstep(0.0, 0.5, vUv.y) * smoothstep(1.0, 0.5, vUv.y);
          float sw = 0.5 + 0.5*sin(a*3.0 - uTime*4.0 + n*6.0);
          gl_FragColor = vec4(uColor*(1.5 + sw*3.5)*band*band*(0.5+n), band*uOpen);
        }`,
    });
    this.rim = new THREE.Mesh(new THREE.RingGeometry(PORTAL_RADIUS * 0.97, PORTAL_RADIUS * 1.16, 128, 1), this.rimMat);
    // RingGeometry UVs are planar; remap to (angle, radial) for the swirl shader.
    const pos = this.rim.geometry.attributes.position as THREE.BufferAttribute;
    const uv = this.rim.geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      uv.setXY(i, (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1, (Math.hypot(x, y) - PORTAL_RADIUS * 0.97) / (PORTAL_RADIUS * 0.19));
    }
    this.rim.position.z = 0.01;
    // Vortex: motes spiralling into the event horizon of the portal
    const N = 900;
    const vg = new THREE.BufferGeometry();
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = Math.random();
    vg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    vg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.vortexMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uColor: { value: color }, uR: { value: PORTAL_RADIUS } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float seed; uniform float uTime, uOpen, uR; varying float vA;
        void main(){ float life = fract(uTime*0.35 + seed);
          float r = uR*(1.55 - life*0.6) * uOpen; float a = seed*62.83 + life*5.0 + uTime*0.6;
          vec3 p = vec3(cos(a)*r, sin(a)*r, (1.0-life)*0.9*(seed-0.5));
          vA = smoothstep(0.0, 0.2, life)*(1.0-life)*uOpen;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = (2.0 + seed*4.0) * 6.0 / -mv.z; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ vec2 q = gl_PointCoord-0.5; float a = exp(-dot(q,q)*20.0); gl_FragColor = vec4(uColor*2.5*a*vA, a*vA); }`,
    });
    this.vortex = new THREE.Points(vg, this.vortexMat);
    this.vortex.frustumCulled = false;
    this.light = new THREE.PointLight(color, 0, 14, 2);
    this.light.position.z = 0.6;
    this.group.add(this.disc, this.rim, this.vortex, this.light);
    this.group.userData.portalId = p.id;
    this.disc.userData.portalId = p.id;
    this.rim.userData.portalId = p.id;
    this.apply(p);
  }

  apply(p: Portal) {
    this.state = p;
    this.group.position.set(...p.position);
    this.group.rotation.set(0, p.yaw ?? 0, 0);
  }

  get normal() {
    const y = this.state.yaw ?? 0;
    return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
  }

  resize(w: number, h: number) {
    this.rt.setSize(w, h);
    this.discMat.uniforms.uRes.value.set(w, h);
  }

  update(t: number, rdt: number) {
    this.open = Math.min(1, this.open + rdt * 1.4);
    const e = 1 - Math.pow(1 - this.open, 3);
    this.discMat.uniforms.uOpen.value = e;
    this.discMat.uniforms.uTime.value = t;
    this.rimMat.uniforms.uTime.value = t;
    this.rimMat.uniforms.uOpen.value = e;
    this.rim.scale.setScalar(0.3 + 0.7 * e);
    this.light.intensity = 14 * e;
    this.vortexMat.uniforms.uTime.value = t;
    this.vortexMat.uniforms.uOpen.value = e;
  }

  dispose() {
    this.rt.dispose();
    this.disc.geometry.dispose();
    this.rim.geometry.dispose();
    this.discMat.dispose();
    this.rimMat.dispose();
  }
}

/** Compute the camera pose on the far side of a portal. */
export function portalCameraMatrix(camera: THREE.Camera, entrance: THREE.Matrix4, exit: THREE.Matrix4, out = new THREE.Matrix4()) {
  const flip = new THREE.Matrix4().makeRotationY(Math.PI);
  return out.copy(exit).multiply(flip).multiply(entrance.clone().invert()).multiply(camera.matrixWorld);
}
