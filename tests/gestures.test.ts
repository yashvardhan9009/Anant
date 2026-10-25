import { describe, it, expect } from 'vitest';
import { GestureEngine, classifyPose, detectCircle, LM, HandFrame } from '../shared/gestures';

/** Build a synthetic right hand: wrist at (cx, cy+0.15), fingers pointing up. */
function hand(opts: { cx?: number; cy?: number; s?: number; pinch?: boolean; fingers?: [boolean, boolean, boolean, boolean]; roll?: number } = {}): LM[] {
  const { cx = 0.5, cy = 0.5, s = 1, pinch = false, fingers = [true, true, true, true], roll = 0 } = opts;
  const lm: LM[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  const P = (i: number, x: number, y: number) => {
    const c = Math.cos(roll), sn = Math.sin(roll);
    lm[i] = { x: cx + (x * c - y * sn) * s, y: cy + (x * sn + y * c) * s, z: 0 };
  };
  P(0, 0, 0.15);
  const cols = [-0.045, -0.015, 0.015, 0.045];
  const base = [5, 9, 13, 17];
  base.forEach((b, f) => {
    P(b, cols[f], 0.05); // MCP
    P(b + 1, cols[f], 0.0); // PIP
    if (fingers[f]) { P(b + 2, cols[f], -0.04); P(b + 3, cols[f], -0.08); } // extended
    else { P(b + 2, cols[f], 0.04); P(b + 3, cols[f], 0.08); } // curled toward wrist
  });
  P(1, -0.06, 0.12); P(2, -0.08, 0.08); P(3, -0.1, 0.04);
  if (pinch) { lm[4] = { ...lm[8] }; lm[4].x += 0.005 * s; } else P(4, -0.14, 0.0);
  return lm;
}
const frame = (lm: LM[], score = 0.95): HandFrame => ({ landmarks: lm, handedness: 'Right', score });

describe('pose classification', () => {
  it('open palm, pinch, point, fist', () => {
    expect(classifyPose(hand())).toBe('open_palm');
    expect(classifyPose(hand({ pinch: true }))).toBe('pinch');
    expect(classifyPose(hand({ fingers: [true, false, false, false] }))).toBe('point');
    expect(classifyPose(hand({ fingers: [false, false, false, false] }))).toBe('fist');
  });
  it('is scale invariant', () => {
    expect(classifyPose(hand({ s: 0.4, pinch: true }))).toBe('pinch');
    expect(classifyPose(hand({ s: 2.2 }))).toBe('open_palm');
  });
});

describe('gesture engine', () => {
  it('needs stable frames before pinch fires, and ends on release', () => {
    const g = new GestureEngine({ stableFrames: 3 });
    const evs = [0, 1, 2, 3].flatMap((i) => g.process([frame(hand({ pinch: true }))], i * 16));
    expect(evs.filter((e) => e.type === 'pinch_start')).toHaveLength(1);
    expect(evs.findIndex((e) => e.type === 'pinch_start')).toBeGreaterThan(evs.findIndex((e, i) => i > 0 && e.type === 'cursor'));
    const end = [4, 5, 6, 7].flatMap((i) => g.process([frame(hand())], i * 16));
    expect(end.some((e) => e.type === 'pinch_end')).toBe(true);
  });
  it('ignores low-confidence detections', () => {
    const g = new GestureEngine();
    const evs = [0, 1, 2, 3].flatMap((i) => g.process([frame(hand({ pinch: true }), 0.3)], i * 16));
    expect(evs.some((e) => e.type === 'pinch_start')).toBe(false);
  });
  it('a single flickering frame does not trigger a pinch', () => {
    const g = new GestureEngine({ stableFrames: 3 });
    const seq = [false, false, true, false, false, true, false];
    const evs = seq.flatMap((p, i) => g.process([frame(hand({ pinch: p }))], i * 16));
    expect(evs.some((e) => e.type === 'pinch_start')).toBe(false);
  });
  it('wrist roll while pinching emits rotate', () => {
    const g = new GestureEngine({ stableFrames: 1 });
    const evs = [0, 0.05, 0.1, 0.15].flatMap((r, i) => g.process([frame(hand({ pinch: true, roll: r }))], i * 16));
    const rot = evs.filter((e) => e.type === 'rotate') as any[];
    expect(rot.length).toBeGreaterThan(1);
    expect(rot.reduce((a, e) => a + e.delta, 0)).toBeCloseTo(-0.15, 2);
  });
  it('two-hand pinch spread emits scale > 1', () => {
    const g = new GestureEngine();
    const evs = [0.1, 0.12, 0.14].flatMap((d, i) => g.process([frame(hand({ cx: 0.5 - d, pinch: true })), frame(hand({ cx: 0.5 + d, pinch: true }))], i * 16));
    const sc = evs.filter((e) => e.type === 'two_hand_scale') as any[];
    expect(sc.length).toBe(2);
    expect(sc[0].factor).toBeGreaterThan(1);
  });
  it('drawing a circle with the index finger opens a portal (once, with cooldown)', () => {
    const g = new GestureEngine({ stableFrames: 2 });
    const evs: any[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 36) * 2 * Math.PI;
      const tip = { x: 0.5 + 0.12 * Math.cos(a), y: 0.5 + 0.12 * Math.sin(a) };
      const lm = hand({ fingers: [true, false, false, false], cx: tip.x, cy: tip.y + 0.08 });
      evs.push(...g.process([frame(lm)], i * 30));
    }
    expect(evs.filter((e) => e.type === 'circle')).toHaveLength(1);
  });
  it('holding an open palm opens the creation menu', () => {
    const g = new GestureEngine({ palmHoldMs: 500 });
    const evs = Array.from({ length: 50 }, (_, i) => g.process([frame(hand())], i * 16)).flat();
    expect(evs.filter((e) => e.type === 'open_palm')).toHaveLength(1);
  });
  it('a palm that rapidly grows (moves toward camera) is a push', () => {
    const g = new GestureEngine({ stableFrames: 2 });
    const evs = Array.from({ length: 12 }, (_, i) => g.process([frame(hand({ s: 1 + i * 0.06 }))], i * 20)).flat();
    expect(evs.some((e) => e.type === 'push')).toBe(true);
  });
});

describe('circle detector', () => {
  it('rejects lines and partial arcs', () => {
    expect(detectCircle(Array.from({ length: 30 }, (_, i) => ({ x: i / 30, y: 0.5 })))).toBeNull();
    expect(detectCircle(Array.from({ length: 30 }, (_, i) => ({ x: 0.5 + 0.1 * Math.cos(i / 30 * Math.PI), y: 0.5 + 0.1 * Math.sin(i / 30 * Math.PI) })))).toBeNull();
  });
});
