import * as T from "three";

/** Material-scale stains, colour variation and dirt under eaves. Keeps light response PBR. */
export function buildingWeather(
  material: T.MeshStandardMaterial,
  wood = false,
) {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (sh, renderer) => {
    before.call(material, sh, renderer);
    sh.vertexShader =
      "varying vec3 buildingWorld;\n" +
      sh.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nbuildingWorld=(modelMatrix*vec4(transformed,1.)).xyz;",
      );
    sh.fragmentShader =
      "varying vec3 buildingWorld;\n" +
      sh.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
      float grain=sin(buildingWorld.x*1.87+sin(buildingWorld.z*2.3))*sin(buildingWorld.y*3.1+buildingWorld.z*.7);
      float soil=(1.-smoothstep(.15,1.5,buildingWorld.y))*(.55+.45*sin(buildingWorld.x*3.+buildingWorld.z*4.1));
      float weather=.91+grain*.06;diffuseColor.rgb*=weather*mix(vec3(1.),vec3(.47,.44,.35),soil*.5);
      ${wood ? "diffuseColor.rgb*=vec3(.78,.76,.69);" : ""}
    `,
      );
  };
  material.customProgramCacheKey = () =>
    wood ? "weathered-building-wood-v1" : "weathered-building-plaster-v1";
}
