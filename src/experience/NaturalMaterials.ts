import * as T from "three";
import { addWind } from "../engine/architecture";

/** Leaf motion plus a restrained backlight term. This approximates thin-leaf
 * transmission; it is not a subsurface or global-illumination solver. */
export function naturalFoliage(
  material: T.MeshStandardMaterial,
  tree: boolean,
) {
  addWind(material, tree ? "tree" : "plant");
  const wind = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    wind.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_fragment_end>",
      `
      #include <lights_fragment_end>
      reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(.045,.065,.025) * (1.0-abs(dot(normal,geometryViewDir)));
    `,
    );
  };
  material.customProgramCacheKey = () =>
    tree ? "studio-leaf-tree-v1" : "studio-leaf-plant-v1";
}

/** World-scale stone stops tiny capitals and long shafts stretching the same
 * UV patch. Low-level damp staining and mottling break up repeated modules. */
export function weatherStone(material: T.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec3 stoneWorld;varying vec3 stoneNormal;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `
      #include <begin_vertex>
      vec4 stonePosition=vec4(transformed,1.);
      #ifdef USE_INSTANCING
      stonePosition=instanceMatrix*stonePosition;
      #endif
      stoneWorld=(modelMatrix*stonePosition).xyz;stoneNormal=normalize(mat3(modelMatrix)*normal);
    `,
      );
    shader.fragmentShader =
      "varying vec3 stoneWorld;varying vec3 stoneNormal;\n" +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        `
      #ifdef USE_MAP
      vec3 w=pow(abs(stoneNormal),vec3(4.));w/=max(.001,w.x+w.y+w.z);
      vec3 s=texture2D(map,stoneWorld.yz*.42).rgb*w.x+texture2D(map,stoneWorld.xz*.42).rgb*w.y+texture2D(map,stoneWorld.xy*.42).rgb*w.z;
      float mottling=.94+.06*sin(stoneWorld.x*1.2+sin(stoneWorld.z*.7))*sin(stoneWorld.y*1.7);
      float damp=(1.-smoothstep(0.,.8,stoneWorld.y))*(.55+.45*sin(stoneWorld.x*3.1+stoneWorld.z*2.7));
      diffuseColor.rgb*=s*mottling*mix(vec3(1.),vec3(.57,.65,.47),damp*.5);
      #endif
    `,
      );
  };
  material.customProgramCacheKey = () => "studio-world-stone-v1";
}
