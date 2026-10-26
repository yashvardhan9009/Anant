/**
 * Input abstraction. Mouse/keyboard/touch and webcam hand gestures are mapped to
 * the SAME abstract actions (select, grab/move, scale, rotate, create-menu,
 * draw-portal, push). A future WebXR controller source only needs to emit these.
 */
import * as THREE from 'three';
import type { GestureEvent, HandFrame } from '../../shared/gestures';
import { detectCircle } from '../../shared/gestures';
import type { Engine, PickResult } from '../engine/Engine';

export interface InputHost {
  engine: Engine;
  isTyping(): boolean;
  pickAction(p: PickResult, via: 'mouse' | 'hand'): void;
  beginGrab(objectId: string, point: THREE.Vector3): boolean;
  moveGrab(ndc: THREE.Vector2, depth: number): void;
  endGrab(): void;
  scaleSelected(factor: number): void;
  rotateSelected(delta: number): void;
  openCreateMenu(x: number, y: number): void;
  menuOpen(): boolean;
  menuHover(x: number, y: number): void;
  menuCommit(x: number, y: number): void;
  closeMenus(): void;
  drawPortal(ndc: THREE.Vector2, via: 'mouse' | 'hand'): void;
  push(ndc: THREE.Vector2, strength: number): void;
  hover(p: PickResult, x: number, y: number): void;
  hotkey(key: string, down: boolean): boolean;
  wheel(delta: number): void;
  beginBodyGrab(id: string): boolean;
  moveBody(ndc: THREE.Vector2): void;
  releaseBody(): void;
}

export class InputRouter {
  overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private down?: { x: number; y: number; button: number; moved: boolean; grabbing: boolean; body?: boolean };
  private stroke: { x: number; y: number }[] = [];
  private handCursors: { x: number; y: number; pose: string }[] = [];
  private handTrail: { x: number; y: number }[] = [];
  private handGrab = false;
  private handBody = false;
  private handGrabbingCamera = false;
  private palmProgress = 0;
  handsActive = false;

  constructor(private host: InputHost, private el: HTMLElement) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'input-overlay';
    document.body.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d')!;
    const resize = () => {
      this.overlay.width = innerWidth * devicePixelRatio;
      this.overlay.height = innerHeight * devicePixelRatio;
    };
    resize();
    addEventListener('resize', resize);
    el.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.host.engine.rig.keys.clear());
  }

  private ndc(x: number, y: number) {
    return new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  }

  private onDown = (e: PointerEvent) => {
    if (this.host.engine.suspended) return;
    if (this.host.menuOpen()) {
      this.host.menuCommit(e.clientX, e.clientY);
      return;
    }
    this.down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, grabbing: false };
    if (e.button === 2) {
      this.stroke = [{ x: e.clientX, y: e.clientY }];
      return;
    }
    const p = this.host.engine.pick(this.ndc(e.clientX, e.clientY));
    if (p.objectId && p.point && this.host.beginGrab(p.objectId, p.point)) this.down.grabbing = true;
    else if (p.bodyId && e.shiftKey && this.host.beginBodyGrab(p.bodyId)) { this.down.grabbing = true; this.down.body = true; }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (this.host.engine.suspended) return;
    if (this.host.menuOpen()) this.host.menuHover(e.clientX, e.clientY);
    if (!this.down) {
      this.host.moveBody(this.ndc(e.clientX, e.clientY)); // a body held by voice follows the pointer
      if (e.target === this.host.engine.renderer.domElement) this.host.hover(this.host.engine.pick(this.ndc(e.clientX, e.clientY)), e.clientX, e.clientY);
      return;
    }
    const dx = e.movementX, dy = e.movementY;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) this.down.moved = true;
    if (this.down.button === 2) {
      this.stroke.push({ x: e.clientX, y: e.clientY });
      return;
    }
    if (this.down.body) this.host.moveBody(this.ndc(e.clientX, e.clientY));
    else if (this.down.grabbing) this.host.moveGrab(this.ndc(e.clientX, e.clientY), 0);
    else this.host.engine.rig.rotate(dx, dy);
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = undefined;
    if (this.host.engine.suspended) return;
    if (!d) return;
    if (d.button === 2) {
      // Measure circles in pixels: independently normalising X/Y turns a circle
      // into an ellipse on widescreen displays.
      const c = detectCircle(this.stroke, Math.min(innerWidth, innerHeight) * 0.03);
      this.stroke = [];
      if (c) this.host.drawPortal(this.ndc(c.cx, c.cy), 'mouse');
      return;
    }
    if (d.body) { this.host.releaseBody(); return; }
    if (d.grabbing) this.host.endGrab();
    if (!d.moved) this.host.pickAction(this.host.engine.pick(this.ndc(e.clientX, e.clientY)), 'mouse');
  };

  private onWheel = (e: WheelEvent) => {
    if (this.host.engine.suspended) return;
    e.preventDefault();
    if (e.shiftKey) this.host.scaleSelected(e.deltaY < 0 ? 1.08 : 1 / 1.08);
    else if (e.altKey) this.host.rotateSelected(e.deltaY < 0 ? 0.15 : -0.15);
    else this.host.wheel(e.deltaY);
  };

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.host.engine.suspended) return;
    if (this.host.isTyping()) return;
    const k = e.key.toLowerCase();
    if (this.host.hotkey(k, down)) {
      e.preventDefault();
      return;
    }
    if (['w', 'a', 's', 'd', 'e', 'q', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      if (down) this.host.engine.rig.keys.add(k);
      else this.host.engine.rig.keys.delete(k);
    }
  }

  /** Hand-tracking events → the same abstract actions. */
  handleGestures(events: GestureEvent[], hands: HandFrame[]) {
    if (this.host.engine.suspended) return;
    this.handsActive = hands.length > 0;
    this.handCursors = [];
    const W = innerWidth, H = innerHeight;
    for (const ev of events) {
      switch (ev.type) {
        case 'cursor': {
          this.handCursors.push({ x: ev.x * W, y: ev.y * H, pose: ev.pose });
          if (ev.hand === 0) {
            if (this.host.menuOpen()) this.host.menuHover(ev.x * W, ev.y * H);
            else if (!this.handGrab) this.host.hover(this.host.engine.pick(this.ndc(ev.x * W, ev.y * H)), ev.x * W, ev.y * H);
          }
          this.palmProgress = ev.pose === 'open_palm' ? Math.min(1, this.palmProgress + 0.03) : 0;
          if (ev.pose === 'point') {
            this.handTrail.push({ x: ev.x * W, y: ev.y * H });
            if (this.handTrail.length > 90) this.handTrail.shift();
          } else this.handTrail = [];
          break;
        }
        case 'pinch_start': {
          const x = ev.x * W, y = ev.y * H;
          if (this.host.menuOpen()) { this.host.menuCommit(x, y); break; }
          const p = this.host.engine.pick(this.ndc(x, y));
          if (p.objectId && p.point && this.host.beginGrab(p.objectId, p.point)) this.handGrab = true;
          else if (p.bodyId && this.host.beginBodyGrab(p.bodyId)) this.handBody = true;
          else if (p.npcId || p.portalId || p.gate || p.bodyId) this.host.pickAction(p, 'hand');
          else this.handGrabbingCamera = true;
          break;
        }
        case 'pinch_move':
          if (this.handBody) this.host.moveBody(this.ndc(ev.x * W, ev.y * H));
          else if (this.handGrab) this.host.moveGrab(this.ndc(ev.x * W, ev.y * H), ev.depth);
          else if (this.handGrabbingCamera) this.host.engine.rig.rotate(-ev.dx * W * 0.9, -ev.dy * H * 0.9);
          break;
        case 'pinch_end':
          if (this.handBody) { this.host.releaseBody(); this.handBody = false; }
          if (this.handGrab) this.host.endGrab();
          this.handGrab = false;
          this.handGrabbingCamera = false;
          break;
        case 'two_hand_scale':
          this.host.scaleSelected(ev.factor);
          break;
        case 'rotate':
          if (this.handGrab) this.host.rotateSelected(ev.delta * 1.5);
          break;
        case 'open_palm':
          if (!this.host.menuOpen()) this.host.openCreateMenu(ev.x * W, ev.y * H);
          break;
        case 'circle':
          this.handTrail = [];
          this.host.drawPortal(this.ndc(ev.x * W, ev.y * H), 'hand');
          break;
        case 'push':
          this.host.push(this.ndc(ev.x * W, ev.y * H), Math.min(3, ev.strength * 6));
          break;
        case 'lost':
          if (this.handGrab) this.host.endGrab();
          this.handGrab = false;
          this.handGrabbingCamera = false;
          this.handTrail = [];
          break;
      }
    }
  }

  /** Draw cursors, gesture trails and the mouse circle stroke. */
  draw() {
    const c = this.ctx, dpr = devicePixelRatio;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    const trail = (pts: { x: number; y: number }[], color: string) => {
      if (pts.length < 2) return;
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.shadowColor = color;
      c.shadowBlur = 14;
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
      c.shadowBlur = 0;
    };
    trail(this.stroke, '#b388ff');
    trail(this.handTrail, '#7df9ff');
    for (const h of this.handCursors) {
      const pinch = h.pose === 'pinch';
      c.strokeStyle = pinch ? '#ffd27d' : h.pose === 'point' ? '#7df9ff' : h.pose === 'open_palm' ? '#b388ff' : 'rgba(255,255,255,.6)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(h.x, h.y, pinch ? 10 : 18, 0, Math.PI * 2);
      c.stroke();
      if (pinch) {
        c.fillStyle = 'rgba(255,210,125,.35)';
        c.fill();
      }
      if (h.pose === 'open_palm' && this.palmProgress > 0) {
        c.strokeStyle = '#b388ff';
        c.lineWidth = 3;
        c.beginPath();
        c.arc(h.x, h.y, 26, -Math.PI / 2, -Math.PI / 2 + this.palmProgress * Math.PI * 2);
        c.stroke();
      }
      c.fillStyle = 'rgba(255,255,255,.75)';
      c.font = '10px JetBrains Mono, monospace';
      c.fillText(h.pose === 'none' ? '' : h.pose.replace('_', ' '), h.x + 22, h.y + 4);
    }
  }
}
