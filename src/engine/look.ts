import * as THREE from 'three';

/** Per-realm cinematic grade. Bloom runs on HDR (pre-tonemap); grading runs in display space. */
export interface Look {
  exposure: number;
  bloom: [strength: number, radius: number, threshold: number];
  contrast: number;
  saturation: number;
  /** colour pushed into shadows / highlights (split toning) */
  shadows: string;
  highlights: string;
  vignette: number;
  godRays: number;
}

export const DEFAULT_LOOK: Look = { exposure: 1, bloom: [0.35, 0.45, 0.9], contrast: 1.08, saturation: 1.0, shadows: '#0a1020', highlights: '#fff2e0', vignette: 0.55, godRays: 0 };

/** Film grade + warp + chromatic aberration + grain, in one pass. */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAmt: { value: 0 },
    uFlash: { value: 0 },
    uColor: { value: new THREE.Color('#b388ff') },
    uContrast: { value: 1.08 },
    uSat: { value: 1 },
    uShadows: { value: new THREE.Color('#0a1020') },
    uHighlights: { value: new THREE.Color('#fff2e0') },
    uVignette: { value: 0.55 },
    uBars: { value: 0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uGrain: { value: 0.006 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uAmt, uFlash, uContrast, uSat, uVignette, uBars;
    uniform vec3 uColor, uShadows, uHighlights; uniform vec2 uResolution; uniform float uGrain; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r = length(c);
      float amt = uAmt*uAmt;
      // subtle lens chromatic aberration at the edges, stronger while warping
      float ca = 0.00012*r*r*4.0 + amt*0.02;
      vec3 col;
      if (amt > 0.001) {
        col = vec3(0.0);
        for (int i = 0; i < 10; i++) {
          float k = float(i)/9.0; vec2 o = c*(1.0 - amt*0.35*k);
          col.r += texture2D(tDiffuse, 0.5 + o*(1.0+ca)).r; col.g += texture2D(tDiffuse, 0.5 + o).g; col.b += texture2D(tDiffuse, 0.5 + o*(1.0-ca)).b;
        }
        col /= 10.0;
        float a = atan(c.y, c.x);
        col += uColor * pow(h(vec2(floor(a*70.0), 0.0)), 10.0) * smoothstep(0.1, 0.7, r) * amt * 2.0;
      } else {
        col = vec3(texture2D(tDiffuse, 0.5 + c*(1.0+ca)).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, 0.5 + c*(1.0-ca)).b);
      }
      // grade (display space)
      float l = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(l), col, uSat);
      col += uShadows * (1.0-smoothstep(0.0,0.4,l)) * l * 0.2;
      col = mix(col, col*uHighlights, smoothstep(0.45,1.0,l)*0.12);
      // A gentle S-curve retains shadow detail instead of clipping it away.
      col = mix(col, smoothstep(vec3(0.0), vec3(1.0), col), clamp((uContrast-1.0)*2.0, 0.0, 0.5));
      col = clamp(col, 0.0, 1.0);
      col = mix(col, uColor*1.4 + 0.5, uFlash);
      col *= 1.0 - smoothstep(0.35, 0.95, r)*(uVignette + amt*0.4);
      col += (h(floor(vUv*uResolution) + floor(uTime*24.0)*91.0) - 0.5) * uGrain * (0.35 + 0.65*sin(clamp(l,0.0,1.0)*3.14159));
      // letterbox bars during cinematic transitions
      float bar = uBars*0.11;
      if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

/** Screen-space light scattering (god rays) from a sun position, applied in HDR. */
export const GodRayShader = {
  uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uStrength: { value: 0 }, uTint: { value: new THREE.Color('#ffb070') } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uStrength; uniform vec3 uTint; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength <= 0.001) { gl_FragColor = base; return; }
      vec2 d = (uSun - vUv) / 40.0;
      vec2 uv = vUv; float w = 1.0; vec3 acc = vec3(0.0);
      for (int i = 0; i < 40; i++) {
        uv += d;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float lum = dot(s, vec3(0.3,0.59,0.11));
        acc += s * smoothstep(0.7, 2.2, lum) * w;
        w *= 0.955;
      }
      gl_FragColor = vec4(base.rgb + acc/40.0 * uStrength * uTint * 2.5, base.a);
    }`,
};
