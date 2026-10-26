import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraRig } from '../src/engine/CameraRig';
import type { Realm } from '../src/engine/Realm';

describe('moving subject camera', () => {
  it('keeps a fast orbiting subject centred after the simulation advances', () => {
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
    expect(camera.position.clone().sub(subject).distanceTo(offset)).toBeLessThan(1e-10);
  });

  it('does not snap to the subject during a cinematic arrival', () => {
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
