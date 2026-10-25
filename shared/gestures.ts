/**
 * Gesture recognition on MediaPipe hand landmarks (21 points per hand,
 * normalized image coordinates). Pure and deterministic → unit-testable.
 *
 * Robustness measures:
 *  - all distances are normalized by hand size (wrist → middle-finger MCP)
 *  - pinch uses hysteresis (separate enter/exit thresholds)
 *  - poses must be stable for N frames before they fire
 *  - detector confidence below `minScore` is ignored
 *  - one-shot gestures (palm menu, circle, push) have cooldowns
 */

export interface LM { x: number; y: number; z: number }
export interface HandFrame { landmarks: LM[]; handedness: 'Left' | 'Right'; score: number }
export type Pose = 'pinch' | 'point' | 'open_palm' | 'fist' | 'none';

export const IDX = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12, RING_PIP: 14, RING_TIP: 16, PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20 };

const d2 = (a: LM, b: LM) => Math.hypot(a.x - b.x, a.y - b.y);

export function handScale(lm: LM[]): number {
  return Math.max(1e-4, d2(lm[IDX.WRIST], lm[IDX.MIDDLE_MCP]));
}

export function pinchRatio(lm: LM[]): number {
  return d2(lm[IDX.THUMB_TIP], lm[IDX.INDEX_TIP]) / handScale(lm);
}

/** A finger is extended when its tip is clearly farther from the wrist than its PIP joint. */
export function extended(lm: LM[], tip: number, pip: number): boolean {
  return d2(lm[tip], lm[IDX.WRIST]) > d2(lm[pip], lm[IDX.WRIST]) * 1.18;
}

export function fingerStates(lm: LM[]) {
  return {
    index: extended(lm, IDX.INDEX_TIP, IDX.INDEX_PIP),
    middle: extended(lm, IDX.MIDDLE_TIP, IDX.MIDDLE_PIP),
    ring: extended(lm, IDX.RING_TIP, IDX.RING_PIP),
    pinky: extended(lm, IDX.PINKY_TIP, IDX.PINKY_PIP),
  };
}

export const PINCH_ENTER = 0.32;
export const PINCH_EXIT = 0.5;

export function classifyPose(lm: LM[], wasPinching = false): Pose {
  const pr = pinchRatio(lm);
  if (pr < (wasPinching ? PINCH_EXIT : PINCH_ENTER)) return 'pinch';
  const f = fingerStates(lm);
  const n = +f.index + +f.middle + +f.ring + +f.pinky;
  if (n === 4 && pr > 0.6) return 'open_palm';
  if (f.index && !f.middle && !f.ring && !f.pinky) return 'point';
  if (n === 0) return 'fist';
  return 'none';
}

/** Roll of the hand in the image plane (radians), from index MCP → pinky MCP. */
export function rollAngle(lm: LM[]): number {
  const a = lm[IDX.INDEX_MCP], b = lm[IDX.PINKY_MCP];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Cursor = midpoint of thumb & index tips (pinch) or index tip (point). Mirrored for selfie view. */
export function cursorOf(lm: LM[], pose: Pose): { x: number; y: number } {
  const p = pose === 'pinch'
    ? { x: (lm[IDX.THUMB_TIP].x + lm[IDX.INDEX_TIP].x) / 2, y: (lm[IDX.THUMB_TIP].y + lm[IDX.INDEX_TIP].y) / 2 }
    : lm[IDX.INDEX_TIP];
  return { x: 1 - p.x, y: p.y };
}

export interface CircleResult { cx: number; cy: number; r: number; sweep: number; roundness: number }

/**
 * Detect a closed, roughly circular stroke.
 * Criteria: total angular sweep around the centroid ≥ 300°, radius coefficient
 * of variation ≤ 0.3, radius large enough to be deliberate, and the stroke closes.
 */
export function detectCircle(pts: { x: number; y: number }[], minRadius = 0.05): CircleResult | null {
  if (pts.length < 14) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const rs = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const r = rs.reduce((a, b) => a + b, 0) / rs.length;
  if (r < minRadius) return null;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - r) ** 2, 0) / rs.length);
  const roundness = 1 - sd / r;
  if (sd / r > 0.3) return null;
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = Math.atan2(pts[i].y - cy, pts[i].x - cx) - Math.atan2(pts[i - 1].y - cy, pts[i - 1].x - cx);
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    sweep += a;
  }
  if (Math.abs(sweep) < (300 * Math.PI) / 180) return null;
  const closeGap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  if (closeGap > r * 0.9) return null;
  return { cx, cy, r, sweep: Math.abs(sweep), roundness };
}

export type GestureEvent =
  | { type: 'cursor'; hand: number; x: number; y: number; pose: Pose }
  | { type: 'pinch_start'; x: number; y: number }
  | { type: 'pinch_move'; x: number; y: number; dx: number; dy: number; depth: number }
  | { type: 'pinch_end'; x: number; y: number }
  | { type: 'two_hand_scale'; factor: number }
  | { type: 'rotate'; delta: number }
  | { type: 'open_palm'; x: number; y: number }
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'push'; x: number; y: number; strength: number }
  | { type: 'point'; x: number; y: number }
  | { type: 'lost' };

export interface GestureOptions {
  minScore: number;
  stableFrames: number;
  palmHoldMs: number;
  cooldownMs: number;
}

const DEFAULTS: GestureOptions = { minScore: 0.6, stableFrames: 3, palmHoldMs: 700, cooldownMs: 1200 };

/** Stateful recogniser: feed it frames, get high-level events. */
export class GestureEngine {
  opts: GestureOptions;
  private pinching = false;
  private poseHist: Pose[] = [];
  private stablePose: Pose = 'none';
  private last = { x: 0.5, y: 0.5 };
  private lastRoll: number | null = null;
  private lastScale: number | null = null;
  private twoHandDist: number | null = null;
  private palmSince: number | null = null;
  private trail: { x: number; y: number; t: number }[] = [];
  private cooldown: Record<string, number> = {};
  private scaleHist: { s: number; t: number }[] = [];

  constructor(opts: Partial<GestureOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get pose() { return this.stablePose; }
  get isPinching() { return this.pinching; }
  get trailPoints() { return this.trail; }

  private ready(kind: string, t: number) {
    if ((this.cooldown[kind] ?? -Infinity) > t) return false;
    this.cooldown[kind] = t + this.opts.cooldownMs;
    return true;
  }

  process(hands: HandFrame[], t: number): GestureEvent[] {
    const ev: GestureEvent[] = [];
    const good = hands.filter((h) => h.score >= this.opts.minScore && h.landmarks.length === 21);
    if (!good.length) {
      if (this.pinching) ev.push({ type: 'pinch_end', ...this.last });
      this.pinching = false;
      this.poseHist = [];
      this.stablePose = 'none';
      this.trail = [];
      this.palmSince = null;
      this.twoHandDist = null;
      this.lastRoll = null;
      ev.push({ type: 'lost' });
      return ev;
    }

    // ——— two-hand scale: both hands pinching ———
    if (good.length >= 2) {
      const p0 = classifyPose(good[0].landmarks, true), p1 = classifyPose(good[1].landmarks, true);
      if (p0 === 'pinch' && p1 === 'pinch') {
        const c0 = cursorOf(good[0].landmarks, 'pinch'), c1 = cursorOf(good[1].landmarks, 'pinch');
        const dist = Math.hypot(c0.x - c1.x, c0.y - c1.y);
        if (this.twoHandDist !== null && this.twoHandDist > 0.02) {
          const f = dist / this.twoHandDist;
          if (Math.abs(f - 1) > 0.004) ev.push({ type: 'two_hand_scale', factor: Math.max(0.8, Math.min(1.25, f)) });
        }
        this.twoHandDist = dist;
        ev.push({ type: 'cursor', hand: 0, ...c0, pose: 'pinch' }, { type: 'cursor', hand: 1, ...c1, pose: 'pinch' });
        return ev;
      }
    }
    this.twoHandDist = null;

    // ——— primary hand ———
    const h = good[0];
    const lm = h.landmarks;
    const raw = classifyPose(lm, this.pinching);
    this.poseHist.push(raw);
    if (this.poseHist.length > this.opts.stableFrames) this.poseHist.shift();
    if (this.poseHist.length === this.opts.stableFrames && this.poseHist.every((p) => p === raw)) this.stablePose = raw;
    const pose = this.stablePose;
    const c = cursorOf(lm, pose);
    ev.push({ type: 'cursor', hand: 0, ...c, pose });

    // pinch (grab / move / rotate)
    if (pose === 'pinch' && !this.pinching) {
      this.pinching = true;
      this.lastRoll = rollAngle(lm);
      this.lastScale = handScale(lm);
      ev.push({ type: 'pinch_start', ...c });
    } else if (pose === 'pinch' && this.pinching) {
      const roll = rollAngle(lm);
      if (this.lastRoll !== null) {
        let dr = roll - this.lastRoll;
        while (dr > Math.PI) dr -= 2 * Math.PI;
        while (dr < -Math.PI) dr += 2 * Math.PI;
        if (Math.abs(dr) > 0.015 && Math.abs(dr) < 0.6) ev.push({ type: 'rotate', delta: -dr });
      }
      this.lastRoll = roll;
      const sc = handScale(lm);
      const depth = this.lastScale ? sc / this.lastScale - 1 : 0;
      this.lastScale = sc;
      ev.push({ type: 'pinch_move', ...c, dx: c.x - this.last.x, dy: c.y - this.last.y, depth });
    } else if (pose !== 'pinch' && this.pinching) {
      this.pinching = false;
      this.lastRoll = null;
      ev.push({ type: 'pinch_end', ...this.last });
    }

    // point → draw-circle trail
    if (pose === 'point') {
      ev.push({ type: 'point', ...c });
      this.trail.push({ ...c, t });
      while (this.trail.length && t - this.trail[0].t > 2500) this.trail.shift();
      const circ = detectCircle(this.trail);
      if (circ && this.ready('circle', t)) {
        ev.push({ type: 'circle', x: circ.cx, y: circ.cy, r: circ.r });
        this.trail = [];
      }
    } else if (pose !== 'none') this.trail = [];

    // open palm held → creation menu; quick growth of palm size → push
    if (pose === 'open_palm') {
      const sc = handScale(lm);
      this.scaleHist.push({ s: sc, t });
      while (this.scaleHist.length && t - this.scaleHist[0].t > 300) this.scaleHist.shift();
      const first = this.scaleHist[0];
      if (first && sc / first.s > 1.28 && this.ready('push', t)) {
        ev.push({ type: 'push', ...c, strength: sc / first.s - 1 });
        this.palmSince = null;
      } else {
        if (this.palmSince === null) this.palmSince = t;
        if (t - this.palmSince >= this.opts.palmHoldMs && this.ready('palm', t)) {
          ev.push({ type: 'open_palm', ...c });
          this.palmSince = null;
        }
      }
    } else {
      this.palmSince = null;
      this.scaleHist = [];
    }

    this.last = c;
    return ev;
  }
}
