import * as C from 'cesium';
import { dampedMotion } from '../engine/motion';

export type TravelMode = 'explore' | 'fly' | 'walk';

/** Movement uses metres in the local tangent frame, not globe orbit controls. */
export class EarthNavigator {
  mode: TravelMode = 'explore';
  keys = new Set<string>();
  speed = 0;
  clearance = 0;
  cruise = false;
  landing = false;
  speedMultiplier = 1;
  private velocity = [0, 0, 0];
  private drag?: { id: number; x: number; y: number };
  private removers: (() => void)[] = [];

  constructor(private viewer: C.Viewer, private onInteract: () => void) {
    const canvas = viewer.canvas;
    const listen = (target: EventTarget, name: string, handler: EventListener) => {
      target.addEventListener(name, handler); this.removers.push(() => target.removeEventListener(name, handler));
    };
    listen(window, 'keydown', ((event: KeyboardEvent) => {
      if (this.mode === 'explore' || (event.target as HTMLElement)?.closest('input,select,textarea,button,summary')) return;
      const key = event.key.toLowerCase();
      if (['w','a','s','d','q','e','shift','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
        event.preventDefault(); this.keys.add(key); this.onInteract();
      }
    }) as EventListener);
    listen(window, 'keyup', ((event: KeyboardEvent) => { this.keys.delete(event.key.toLowerCase()); }) as EventListener);
    listen(window, 'blur', (() => this.stop()) as EventListener);
    listen(document, 'visibilitychange', (() => { if (document.hidden) this.stop(); }) as EventListener);
    listen(document, 'focusin', ((event: FocusEvent) => {
      if ((event.target as HTMLElement)?.matches('input,select,textarea')) this.stop();
    }) as EventListener);
    listen(canvas, 'pointerdown', ((event: PointerEvent) => {
      if (this.mode === 'explore' || event.button !== 0) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId); canvas.focus(); this.onInteract();
    }) as EventListener);
    listen(canvas, 'pointermove', ((event: PointerEvent) => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const camera = viewer.camera;
      const heading = camera.heading + (event.clientX - this.drag.x) * .003;
      const pitch = C.Math.clamp(camera.pitch - (event.clientY - this.drag.y) * .003, -1.48, 1.48);
      camera.setView({ orientation: { heading, pitch, roll: 0 } });
      this.drag.x = event.clientX; this.drag.y = event.clientY;
    }) as EventListener);
    const release = ((event: PointerEvent) => { if (this.drag?.id === event.pointerId) this.drag = undefined; }) as EventListener;
    listen(canvas, 'pointerup', release); listen(canvas, 'pointercancel', release); listen(canvas, 'lostpointercapture', release);
    canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Earth view. Drag to look around.');
  }

  setMode(mode: TravelMode) {
    this.stop(); this.mode = mode;
    this.viewer.camera.cancelFlight();
    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.enableInputs = mode === 'explore';
    controller.minimumZoomDistance = mode === 'walk' ? 1.7 : 20;
    const camera = this.viewer.camera;
    if (mode === 'walk') {
      const point = camera.positionCartographic.clone(), ground = this.viewer.scene.globe.getHeight(point);
      // Never descend onto a tile which has not arrived yet.
      if (ground === undefined || !this.viewer.scene.globe.tilesLoaded || point.height > 30000) { this.mode = 'explore'; controller.enableInputs = true; controller.minimumZoomDistance = 20; return false; }
      point.height = ground + 1.7;
      this.landing = true;
      camera.flyTo({ destination: C.Cartesian3.fromRadians(point.longitude, point.latitude, point.height),
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 3,
        orientation: { heading: camera.heading, pitch: -.06, roll: 0 },
        complete: () => { this.landing = false; }, cancel: () => { this.landing = false; } });
    }
    if (mode !== 'explore') this.viewer.canvas.focus();
    return true;
  }

  stop() { this.viewer.camera.cancelFlight(); this.landing = false; this.keys.clear(); this.velocity.fill(0); this.speed = 0; this.cruise = false; this.drag = undefined; }

  update(dt: number) {
    const camera = this.viewer.camera, globe = this.viewer.scene.globe;
    const point = camera.positionCartographic;
    const ground = globe.getHeight(point);
    this.clearance = Math.max(0, point.height - (ground ?? 0));
    if (this.mode === 'explore' || this.landing || document.hidden) { this.speed = 0; return; }
    dt = Math.min(dt, .1);
    const has = (...keys: string[]) => keys.some(key => this.keys.has(key)) ? 1 : 0;
    const forward = has('w','arrowup') - has('s','arrowdown') + (this.cruise ? 1 : 0);
    const sideways = has('d','arrowright') - has('a','arrowleft');
    const vertical = this.mode === 'fly' ? has('e') - has('q') : 0;
    const norm = Math.max(1, Math.hypot(forward, sideways, vertical));
    const baseSpeed = this.mode === 'walk' ? 1.55 : C.Math.clamp(this.clearance * .06, 8, 1200) * this.speedMultiplier;
    const maxSpeed = baseSpeed * (this.keys.has('shift') ? (this.mode === 'walk' ? 2.8 : 3) : 1);
    const delta = [forward, sideways, vertical].map((axis, i) => {
      const m = dampedMotion(this.velocity[i], axis / norm * maxSpeed, this.mode === 'walk' ? 12 : 3.5, dt);
      this.velocity[i] = m.velocity; return m.distance;
    });
    const before = C.Cartesian3.clone(camera.positionWC);
    const up = globe.ellipsoid.geodeticSurfaceNormal(before, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(camera.directionWC, up, new C.Cartesian3()), new C.Cartesian3());
    const ahead = this.mode === 'walk'
      ? C.Cartesian3.normalize(C.Cartesian3.cross(up, right, new C.Cartesian3()), new C.Cartesian3()) : camera.directionWC;
    const next = C.Cartesian3.clone(before);
    for (const [vector, distance] of [[ahead,delta[0]],[right,delta[1]],[up,delta[2]]] as [C.Cartesian3,number][])
      C.Cartesian3.add(next, C.Cartesian3.multiplyByScalar(vector, distance, new C.Cartesian3()), next);
    const position = C.Cartographic.fromCartesian(next);
    const floor = globe.getHeight(position);
    if (floor === undefined) { this.velocity.fill(0); this.speed = 0; return; }
    if (this.mode === 'walk') {
      // Block sheer drops/climbs instead of walking vertically up a cliff.
      if (ground !== undefined && Math.abs(floor - ground) > Math.max(.65, Math.hypot(delta[0],delta[1]) * 1.4)) {
        this.velocity.fill(0); this.speed = 0; return;
      }
      position.height = floor + 1.7;
    } else position.height = Math.max(position.height, floor + 25);
    camera.setView({ destination: C.Cartesian3.fromRadians(position.longitude, position.latitude, position.height),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 } });
    this.speed = dt > 0 ? C.Cartesian3.distance(before, camera.positionWC) / dt : 0;
  }

  dispose() { this.stop(); for (const remove of this.removers) remove(); }
}
