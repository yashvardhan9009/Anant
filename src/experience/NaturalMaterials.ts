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
  material.userData.worldProjection = true;
  material.userData.surfaceRelief = false;
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
      stoneWorld=(modelMatrix*stonePosition).xyz;stoneNormal=inverseTransformDirection(transformedNormal,viewMatrix);
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <normal_fragment_maps>",
        `
      #ifdef USE_NORMALMAP
      vec3 gn=normalize(stoneNormal),nw=pow(abs(gn),vec3(4.));nw/=max(.001,nw.x+nw.y+nw.z);
      vec3 nx=texture2D(normalMap,stoneWorld.yz*.42).xyz*2.-1.;vec3 ny=texture2D(normalMap,stoneWorld.xz*.42).xyz*2.-1.;vec3 nz=texture2D(normalMap,stoneWorld.xy*.42).xyz*2.-1.;
      nx=vec3(nx.xy*normalScale+gn.zy,abs(nx.z)*gn.x);ny=vec3(ny.xy*normalScale+gn.xz,abs(ny.z)*gn.y);nz=vec3(nz.xy*normalScale+gn.xy,abs(nz.z)*gn.z);
      normal=normalize(mat3(viewMatrix)*(nx.zyx*nw.x+ny.xzy*nw.y+nz*nw.z));
      #endif
    `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `
      float roughnessFactor=roughness;
      #ifdef USE_ROUGHNESSMAP
      vec3 rw=pow(abs(normalize(stoneNormal)),vec3(4.));rw/=max(.001,rw.x+rw.y+rw.z);
      roughnessFactor*=texture2D(roughnessMap,stoneWorld.yz*.42).g*rw.x+texture2D(roughnessMap,stoneWorld.xz*.42).g*rw.y+texture2D(roughnessMap,stoneWorld.xy*.42).g*rw.z;
      #endif
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
