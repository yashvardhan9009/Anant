import * as T from "three";
import { assets } from "../engine/assets";
import type { ScenePlan } from "../../shared/experience";
import { refreshRelief } from "../engine/SurfaceRelief";

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, z: number) =>
  fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
export function terrainNoise(x: number, z: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    fx = fract(x),
    fz = fract(z);
  const u = fx * fx * (3 - 2 * fx),
    v = fz * fz * (3 - 2 * fz);
  return T.MathUtils.lerp(
    T.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), u),
    T.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), u),
    v,
  );
}
function fbm(x: number, z: number) {
  let sum = 0,
    amplitude = 0.55;
  for (let i = 0; i < 5; i++) {
    sum += terrainNoise(x, z) * amplitude;
    x = x * 2.03 + 7.1;
    z = z * 2.03 + 13.7;
    amplitude *= 0.48;
  }
  return sum;
}

/** Geometric relief and world-scale scanned material blending. This is an
 * authored landscape, not measured terrain; Earth's DEM stays in its own viewer. */
export function createTerrain(plan: ScenePlan) {
  const group = new T.Group(),
    textures = new Set<T.Texture>();
  const snow = plan.environment.ground === "snow",
    sand = plan.environment.ground === "sand";
  const anchors = [
    ...plan.objects.map((o) => ({
      x: o.position[0],
      z: o.position[2],
      r: Math.max(o.scale[0], o.scale[2]) * (o.kind === "house" ? 3 : 1.8),
    })),
    ...plan.effects.map((e) => ({
      x: e.position[0],
      z: e.position[2],
      r: e.size * 2,
    })),
  ];
  const height = (x: number, z: number) => {
    let weight = 1;
    for (const a of anchors) {
      const d = Math.hypot(x - a.x, z - a.z);
      if (d < a.r + 3)
        weight = Math.min(weight, T.MathUtils.smoothstep(d, a.r, a.r + 3));
    }
    return (
      ((fbm(x * 0.045, z * 0.045) - 0.42) * 1.65 +
        (terrainNoise(x * 1.6, z * 1.6) - 0.5) * 0.035) *
      weight
    );
  };
  const ownMaps = (m: T.MeshStandardMaterial) => {
    for (const key of ["map", "normalMap", "roughnessMap", "aoMap"] as const) {
      const original = m[key];
      if (original) {
        const t = original.clone();
        t.needsUpdate = true;
        m[key] = t;
        textures.add(t);
      }
    }
  };
  const material = new T.MeshStandardMaterial({
    color: snow ? "#e7eef2" : sand ? "#b6a486" : "#ffffff",
    roughness: 0.92,
  });
  if (!snow && !sand && plan.environment.ground !== "obsidian") {
    assets.applyTo(
      material,
      plan.environment.ground === "stone" ? "mossy_rock" : "forest_ground_04",
      1,
      0.75,
    );
    ownMaps(material);
    const moss = new T.MeshStandardMaterial();
    assets.applyTo(moss, "leafy_grass", 1, 0.8);
    const mossMap = moss.map?.clone();
    if (mossMap && plan.environment.ground === "grass") {
      mossMap.needsUpdate = true;
      textures.add(mossMap);
    }
    moss.dispose();
    if (mossMap) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.mossMap = { value: mossMap };
        shader.vertexShader =
          "varying vec3 terrainPosition;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nterrainPosition=position;",
          );
        shader.fragmentShader =
          `varying vec3 terrainPosition;uniform sampler2D mossMap;\n` +
          shader.fragmentShader.replace(
            "#include <map_fragment>",
            `
          #include <map_fragment>
          float groundPatch=sin(terrainPosition.x*.19+sin(terrainPosition.z*.11)*2.)*sin(terrainPosition.z*.15)+sin(terrainPosition.x*.047+terrainPosition.z*.039)*.55;
          float moss=smoothstep(.15,.95,groundPatch)*.72;
          vec3 leaf=texture2D(mossMap,terrainPosition.xz*.33).rgb;
          diffuseColor.rgb=mix(diffuseColor.rgb,leaf*diffuse,moss);
          diffuseColor.rgb*=.91+.09*sin(terrainPosition.x*.08+terrainPosition.z*.13);
        `,
          );
      };
      material.customProgramCacheKey = () => "studio-ground-moss-v1";
    }
  } else if (snow || sand) {
    assets.applyTo(
      material,
      snow ? "snow_02" : "sand_01",
      1,
      snow ? 0.35 : 0.65,
    );
    ownMaps(material);
    material.color.set(snow ? "#eef5fa" : "#c7b18b");
    material.roughness = 0.94;
  } else if (plan.environment.ground === "obsidian") {
    material.color.set("#181e23");
    material.roughness = 0.4;
    material.metalness = 0.3;
  }
  refreshRelief(material);
  const ground = new T.PlaneGeometry(320, 320, 256, 256);
  ground.rotateX(-Math.PI / 2);
  const p = ground.attributes.position,
    uv = ground.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      z = p.getZ(i);
    p.setY(i, height(x, z));
    uv.setXY(i, x * 0.3, z * 0.3);
  }
  ground.computeVertexNormals();
  const floor = new T.Mesh(ground, material);
  floor.receiveShadow = true;
  group.add(floor);

  const nx = 240,
    nz = 112,
    width = 420,
    depth = 200;
  const field = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx) * width - width / 2,
        z = (j / nz) * depth;
      const warp = fbm(x * 0.012, z * 0.012) * 22;
      let ridge = 0,
        a = 1,
        f = 0.014;
      for (let octave = 0; octave < 6; octave++) {
        const n =
          1 - Math.abs(terrainNoise((x + warp) * f, z * f + 6.1) * 2 - 1);
        ridge += n * n * a;
        a *= 0.48;
        f *= 2.12;
      }
      const edge = Math.pow(Math.sin((j / nz) * Math.PI), 1.3);
      field[j * (nx + 1) + i] =
        (ridge * 32 + fbm(x * 0.04, z * 0.04) * 12) * edge;
    }
  // Short thermal relaxation softens artificial needle peaks into talus slopes.
  for (let pass = 0; pass < 12; pass++) {
    const delta = new Float32Array(field.length);
    for (let j = 1; j < nz; j++)
      for (let i = 1; i < nx; i++) {
        const index = j * (nx + 1) + i;
        for (const offset of [1, -1, nx + 1, -nx - 1]) {
          const excess = field[index] - field[index + offset] - 2.8;
          if (excess > 0) {
            const transfer = excess * 0.075;
            delta[index] -= transfer;
            delta[index + offset] += transfer;
          }
        }
      }
    for (let i = 0; i < field.length; i++) field[i] += delta[i];
  }
  const geology = new T.PlaneGeometry(width, depth, nx, nz);
  geology.rotateX(-Math.PI / 2);
  const vertices = geology.attributes.position;
  for (let i = 0; i < vertices.count; i++) vertices.setY(i, field[i]);
  geology.computeVertexNormals();
  const normals = geology.attributes.normal,
    colors = new Float32Array(vertices.count * 3);
  for (let i = 0; i < vertices.count; i++) {
    const slope = 1 - normals.getY(i),
      y = vertices.getY(i),
      x = vertices.getX(i),
      z = vertices.getZ(i);
    const strata = 0.88 + terrainNoise(x * 0.3, y * 0.6 + z * 0.03) * 0.24;
    const c = new T.Color(snow && y > 22 ? "#c5d2db" : "#78766c");
    c.lerp(
      new T.Color("#4e5f44"),
      (1 - T.MathUtils.smoothstep(slope, 0.15, 0.65)) * 0.55,
    );
    c.multiplyScalar(strata);
    colors.set(c.toArray(), i * 3);
  }
  geology.setAttribute("color", new T.BufferAttribute(colors, 3));
  const rock = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  assets.applyTo(rock, "mossy_rock", 1, 0.85);
  ownMaps(rock);
  rock.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec3 geoPosition;varying vec3 geoNormal;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ngeoPosition=position;geoNormal=normal;",
      );
    shader.fragmentShader =
      "varying vec3 geoPosition;varying vec3 geoNormal;\n" +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        `
      #ifdef USE_MAP
      vec3 weights=pow(abs(normalize(geoNormal)),vec3(4.));weights/=max(.001,weights.x+weights.y+weights.z);
      vec3 geology=texture2D(map,geoPosition.yz*.28).rgb*weights.x+texture2D(map,geoPosition.xz*.28).rgb*weights.y+texture2D(map,geoPosition.xy*.28).rgb*weights.z;
      float strata=.89+.11*sin(geoPosition.y*.8+sin(geoPosition.x*.04)*3.+geoPosition.z*.025);
      diffuseColor.rgb*=geology*strata;
      #endif
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <normal_fragment_maps>",
        `
      #ifdef USE_NORMALMAP
      vec3 gn=normalize(geoNormal),w=pow(abs(gn),vec3(4.));w/=max(.001,w.x+w.y+w.z);
      vec3 nx=texture2D(normalMap,geoPosition.yz*.28).xyz*2.-1.;
      vec3 ny=texture2D(normalMap,geoPosition.xz*.28).xyz*2.-1.;
      vec3 nz=texture2D(normalMap,geoPosition.xy*.28).xyz*2.-1.;
      nx=vec3(nx.xy*.55+gn.zy,abs(nx.z)*gn.x);ny=vec3(ny.xy*.55+gn.xz,abs(ny.z)*gn.y);nz=vec3(nz.xy*.55+gn.xy,abs(nz.z)*gn.z);
      normal=normalize(mat3(viewMatrix)*(nx.zyx*w.x+ny.xzy*w.y+nz*w.z));
      #endif
    `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `
      float roughnessFactor=roughness;
      #ifdef USE_ROUGHNESSMAP
      vec3 rw=pow(abs(normalize(geoNormal)),vec3(4.));rw/=max(.001,rw.x+rw.y+rw.z);
      roughnessFactor*=texture2D(roughnessMap,geoPosition.yz*.28).g*rw.x+texture2D(roughnessMap,geoPosition.xz*.28).g*rw.y+texture2D(roughnessMap,geoPosition.xy*.28).g*rw.z;
      #endif
    `,
      );
  };
  rock.customProgramCacheKey = () => "studio-triplanar-geology-v1";
  rock.userData.worldProjection = true;
  rock.userData.surfaceRelief = false;
  // All three surface channels use the same projection; cliffs do not stretch UVs.
  rock.aoMap = null;
  const hills = new T.Mesh(geology, rock);
  hills.position.z = -220;
  hills.receiveShadow = true;
  group.add(hills);
  for (const side of [-1, 1]) {
    const flank = new T.Mesh(geology, rock);
    flank.position.set(side * 230, -4, -135);
    flank.rotation.y = -side * 1.2;
    flank.scale.set(1, 0.72, 1);
    flank.receiveShadow = true;
    group.add(flank);
  }
  return { group, height, textures };
}
