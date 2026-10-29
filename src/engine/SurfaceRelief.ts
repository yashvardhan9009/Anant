import * as T from "three";
import { QUALITY } from "./quality";

interface Relief {
  height: T.Texture;
  depth: number;
  steps: number;
  wrapper: T.Material["onBeforeCompile"];
}
const reliefs = new WeakMap<T.Material, Relief>();

/** Bounded parallax occlusion from the source displacement map. This changes
 * surface sampling, not the mesh silhouette or its physical collision volume. */
export function surfaceRelief(
  material: T.MeshStandardMaterial,
  height: T.Texture,
  depth = 0.025,
) {
  if (!QUALITY.cinematic || !material.map || material.userData.worldProjection)
    return;
  let config = reliefs.get(material);
  if (config && material.onBeforeCompile === config.wrapper) {
    config.height = height;
    config.depth = depth;
    return;
  }
  const previous = material.onBeforeCompile,
    previousKey = material.customProgramCacheKey();
  config = { height, depth, steps: QUALITY.ultra ? 24 : 16, wrapper: () => {} };
  const values = config;
  const wrapper: T.Material["onBeforeCompile"] = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.reliefHeight = { value: values.height };
    shader.uniforms.reliefDepth = { value: values.depth };
    let f = shader.fragmentShader;
    for (const name of [
      "map_fragment",
      "normal_fragment_maps",
      "roughnessmap_fragment",
      "metalnessmap_fragment",
      "aomap_fragment",
    ] as const)
      f = f.replaceAll("#include <" + name + ">", T.ShaderChunk[name]);
    f = f.replaceAll("vMapUv", "reliefUV");
    for (const uv of [
      "vNormalMapUv",
      "vRoughnessMapUv",
      "vMetalnessMapUv",
      "vAoMapUv",
    ])
      f = f.replaceAll(uv, "(" + uv + "+reliefOffset)");
    f = f.replace(
      "vec4 diffuseColor = vec4( diffuse, opacity );",
      `vec4 diffuseColor = vec4( diffuse, opacity );
      #ifdef USE_MAP
      vec2 reliefUV=vMapUv,reliefOffset=vec2(0.);
      float reliefFade=1.-smoothstep(14.,32.,length(vViewPosition));
      if(reliefFade>.001){
        vec3 dx=dFdx(-vViewPosition),dy=dFdy(-vViewPosition);
        vec2 ux=dFdx(vMapUv),uy=dFdy(vMapUv);
        vec3 tr=dx*uy.y-dy*ux.y,br=dy*ux.x-dx*uy.x;
        if(dot(tr,tr)>1e-12&&dot(br,br)>1e-12){
        vec3 tangent=normalize(tr),bitangent=normalize(br);
        #ifdef FLAT_SHADED
        vec3 reliefNormal=normalize(cross(dx,dy));
        #else
        vec3 reliefNormal=normalize(vNormal);
        #endif
        vec3 eye=normalize(vViewPosition),viewT=vec3(dot(eye,tangent),dot(eye,bitangent),abs(dot(eye,reliefNormal)));
        vec2 delta=clamp(viewT.xy/max(.16,viewT.z),vec2(-4.),vec2(4.))*reliefDepth*reliefFade/float(${values.steps});
        float layer=0.,sampleDepth=1.-texture2D(reliefHeight,reliefUV).r;
        for(int i=0;i<${values.steps};i++){if(layer>=sampleDepth)break;reliefUV-=delta;layer+=1./float(${values.steps});sampleDepth=1.-texture2D(reliefHeight,reliefUV).r;}
        vec2 prev=reliefUV+delta;float afterDepth=sampleDepth-layer,beforeDepth=1.-texture2D(reliefHeight,prev).r-layer+1./float(${values.steps});
        float w=clamp(afterDepth/(afterDepth-beforeDepth-.00001),0.,1.);reliefUV=mix(reliefUV,prev,w);reliefOffset=reliefUV-vMapUv;
        }
      }
      #endif
    `,
    );
    shader.fragmentShader =
      "uniform sampler2D reliefHeight;uniform float reliefDepth;\n" + f;
  };
  values.wrapper = wrapper;
  reliefs.set(material, values);
  material.onBeforeCompile = wrapper;
  material.customProgramCacheKey = () =>
    previousKey + "-surface-relief-v1-" + values.steps;
  material.userData.surfaceRelief = true;
  material.needsUpdate = true;
}
/** Call after an object's own shader hook has been attached. */
export function refreshRelief(material: T.MeshStandardMaterial) {
  const r = reliefs.get(material);
  if (r) surfaceRelief(material, r.height, r.depth);
}
