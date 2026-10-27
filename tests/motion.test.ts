import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { dampedMotion, resolveObstacles } from '../src/engine/motion';
import { CameraRig } from '../src/engine/CameraRig';
import type { Realm } from '../src/engine/Realm';

describe('physical movement', () => {
  it('travels the same distance at different frame rates, including braking', () => {
    const simulate = (fps: number) => {
      let v = 0, distance = 0;
      for (let i = 0; i < fps * 3; i++) { const m = dampedMotion(v, i < fps * 2 ? 8 : 0, 3.5, 1/fps); v = m.velocity; distance += m.distance; }
      return { v, distance };
    };
    expect(simulate(20).distance).toBeCloseTo(simulate(120).distance, 9);
    expect(simulate(20).v).toBeCloseTo(simulate(120).v, 9);
  });
  it('resolves a point exactly at an obstacle centre without NaN', () => {
    const safe = resolveObstacles(2,3,[{x:2,z:3,r:4}]);
    expect(Math.hypot(safe.x-2,safe.z-3)).toBeCloseTo(4.28);
  });
  it('prevents a fast walking camera tunnelling through a house', () => {
    const rig = new CameraRig(new PerspectiveCamera());
    const obstacle = {x:0,z:0,r:4};
    const realm = { bounds:100, eyeHeight:1.7, groundY:()=>0, constrainWalk:(p:Vector3)=>{
      const safe=resolveObstacles(p.x,p.z,[obstacle]);p.x=safe.x;p.z=safe.z;return p;
    }} as unknown as Realm;
    rig.setWalk(new Vector3(0,1.7,8),0);rig.speedScale=20;rig.keys.add('w');rig.keys.add('shift');
    for(let i=0;i<20;i++)rig.update(.05,realm);
    expect(rig.pos.z).toBeGreaterThanOrEqual(4.28-1e-8);
    rig.stopMotion();const stopped=rig.pos.clone();rig.update(.05,realm);
    expect(rig.pos.distanceTo(stopped)).toBeLessThan(1e-8);
  });
  it('normalizes diagonal walking speed and keeps steps silent when stationary', () => {
    const realm={bounds:100,eyeHeight:1.7,groundY:()=>0} as unknown as Realm;
    const walk=(diagonal:boolean)=>{const rig=new CameraRig(new PerspectiveCamera());rig.setWalk(new Vector3(0,1.7,0),0);
      let steps=0;rig.onStep=()=>steps++;rig.update(.05,realm);expect(steps).toBe(0);
      rig.keys.add('w');if(diagonal)rig.keys.add('d');for(let i=0;i<60;i++)rig.update(1/60,realm);
      return Math.hypot(rig.pos.x,rig.pos.z);};
    expect(walk(true)).toBeCloseTo(walk(false),8);
    expect(walk(false)).toBeGreaterThan(1.5);expect(walk(false)).toBeLessThan(1.8);
  });
});
