import * as C from 'cesium';

/** Depth-aware aerial perspective. It leaves the sky and orbital view untouched. */
export function cinematicAtmosphere(viewer: C.Viewer) {
  let warmth = 0, haze = 1;
  const stage = viewer.scene.postProcessStages.add(new C.PostProcessStage({
    name: 'anant-aerial-perspective',
    uniforms: { warmth: () => warmth, haze: () => haze,
      surfaceBlend: () => { const x = C.Math.clamp((viewer.camera.positionCartographic.height - 20000) / 130000, 0, 1); return 1 - x*x*(3-2*x); } },
    fragmentShader: `uniform sampler2D colorTexture;
      uniform sampler2D depthTexture;
      uniform float warmth, haze, surfaceBlend;
      in vec2 v_textureCoordinates;
      void main() {
        vec4 base = texture(colorTexture, v_textureCoordinates);
        // This overload handles logarithmic depth itself; do not linearize twice.
        float depth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));
        vec3 color = base.rgb;
        if (depth > 0.0 && depth < 1.0) {
          vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
          float distance = length(eye.xyz / eye.w);
          float air = (1.0 - exp(-distance * .000012 * haze)) * .58 * surfaceBlend;
          vec3 sky = mix(vec3(.60,.71,.80), vec3(.79,.67,.54), warmth);
          color = mix(color, sky, air);
        }
        color *= mix(vec3(1.0), vec3(1.045,1.0,.94), warmth * surfaceBlend);
        vec2 p = v_textureCoordinates - .5;
        color *= 1.0 - .1 * smoothstep(.25,.73,length(p));
        out_FragColor = vec4(color, base.a);
      }`,
  }));
  return { stage, set: (golden: number, atmosphere: number) => { warmth = golden; haze = atmosphere; } };
}
