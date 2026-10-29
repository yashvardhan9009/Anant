import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { CameraRig } from "../src/engine/CameraRig";
import type { Realm } from "../src/engine/Realm";

describe("moving subject camera", () => {
  it('frames elevated flying subjects at the requested three-dimensional distance',()=>{
    const camera=new PerspectiveCamera(),rig=new CameraRig(camera);
    const realm={controlMode:'walk',bounds:100,eyeHeight:1.7,groundY:()=>0} as unknown as Realm;
    rig.setFlight(new Vector3(0,2,10),0);
    const subject=new Vector3(0,20,0);rig.focusOn(subject,12);
    for(let i=0;i<100;i++)rig.update(1/60,realm);
    expect(camera.position.distanceTo(subject)).toBeCloseTo(12,5);
    const projected=subject.clone().project(camera);
    expect(Math.abs(projected.x)).toBeLessThan(.001);expect(Math.abs(projected.y)).toBeLessThan(.001);
  });
  it("starts free flight at the requested pose, rises smoothly and brakes", () => {
    const camera = new PerspectiveCamera(),
      rig = new CameraRig(camera),
      realm = {
        controlMode: "walk",
        bounds: 100,
        eyeHeight: 1.7,
        groundY: () => 0,
      } as unknown as Realm;
    rig.setFlight(new Vector3(0, 2, 12), 0);
    expect(rig.mode).toBe("fly");
    expect(camera.position.y).toBe(2);
    rig.keys.add("e");
    for (let i = 0; i < 60; i++) rig.update(1 / 60, realm);
    expect(rig.pos.y).toBeGreaterThan(4);
    rig.stopMotion();
    const stopped = rig.pos.clone();
    rig.update(0.05, realm);
    expect(rig.pos.distanceTo(stopped)).toBeLessThan(1e-8);
  });
  it("focuses a subject while flying and lets movement interrupt the arrival", () => {
    const rig = new CameraRig(new PerspectiveCamera()),
      realm = {
        controlMode: "walk",
        bounds: 100,
        eyeHeight: 1.7,
        groundY: () => 0,
      } as unknown as Realm;
    rig.setFlight(new Vector3(0, 3, 12), 0);
    rig.focusOn(new Vector3(10, 2, 0), 4);
    for (let i = 0; i < 100; i++) rig.update(1 / 60, realm);
    expect(rig.pos.x).toBeGreaterThan(4);
    expect(rig.pos.z).toBeLessThan(8);
    rig.focusOn(new Vector3(-20, 2, -20), 3);
    rig.keys.add("e");
    const before = rig.pos.y;
    for (let i = 0; i < 60; i++) rig.update(1 / 60, realm);
    expect(rig.pos.y).toBeGreaterThan(before);
  });
  it("keeps a fast orbiting subject centred after the simulation advances", () => {
    const camera = new PerspectiveCamera(46, 16 / 9, 0.05, 3000);
    const rig = new CameraRig(camera);
    const subject = new Vector3(2, 0, 3);
    rig.setOrbit(subject, new Vector3(2, 2, 9));
    rig.follow = () => subject.clone();
    rig.update(1 / 60, {} as Realm);
    const offset = camera.position.clone().sub(subject);
    subject.add(new Vector3(4, -1, -2));
    rig.trackFollow();
    const screen = subject.clone().project(camera);
    expect(Math.abs(screen.x)).toBeLessThan(1e-10);
    expect(Math.abs(screen.y)).toBeLessThan(1e-10);
    expect(
      camera.position.clone().sub(subject).distanceTo(offset),
    ).toBeLessThan(1e-10);
  });

  it("does not snap to the subject during a cinematic arrival", () => {
    const rig = new CameraRig(new PerspectiveCamera());
    rig.setOrbit(new Vector3(), new Vector3(0, 5, 10));
    const subject = new Vector3(20, 0, 0);
    rig.focusOn(subject, 3, () => subject.clone());
    rig.update(1 / 60, {} as Realm);
    const target = rig.target.clone();
    rig.trackFollow();
    expect(rig.target).toEqual(target);
    expect(rig.target.distanceTo(subject)).toBeGreaterThan(1);
  });
});
