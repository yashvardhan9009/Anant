/**
 * Procedural audio (WebAudio, no asset files): an evolving ambient bed per realm
 * plus UI / world sound effects. Starts only after a user gesture.
 */
import type { RealmId } from '../../shared/commands';

const PROFILES: Record<RealmId, { notes: number[]; filter: number; noise: number; detune: number }> = {
  nexus: { notes: [55, 82.4, 110, 164.8], filter: 900, noise: 0.02, detune: 6 },
  atom: { notes: [65.4, 98, 130.8, 196, 261.6], filter: 1600, noise: 0.012, detune: 12 },
  cosmos: { notes: [41.2, 61.7, 82.4, 123.5], filter: 500, noise: 0.03, detune: 4 },
  village: { notes: [73.4, 110, 146.8, 220], filter: 700, noise: 0.05, detune: 3 },
  heavy: { notes: [36.7, 55, 73.4, 110], filter: 380, noise: 0.035, detune: 9 },
};

export class Audio {
  ctx?: AudioContext;
  master?: GainNode;
  private bed?: { gain: GainNode; nodes: AudioScheduledSourceNode[] };
  enabled = true;
  private current?: RealmId;

  start() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    } catch {
      this.ctx = undefined;
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.2);
  }

  private noiseBuffer() {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    return b;
  }

  ambience(realm: RealmId) {
    if (!this.ctx || !this.master || this.current === realm) return;
    this.current = realm;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.bed) {
      const old = this.bed;
      old.gain.gain.setTargetAtTime(0, now, 0.8);
      setTimeout(() => old.nodes.forEach((n) => { try { n.stop(); } catch {} }), 4000);
    }
    const p = PROFILES[realm];
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.32, now, 1.5);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.filter;
    filter.Q.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = p.filter * 0.4;
    lfo.connect(lfoGain).connect(filter.frequency);
    filter.connect(gain).connect(this.master);
    const nodes: AudioScheduledSourceNode[] = [lfo];
    p.notes.forEach((f, i) => {
      for (const det of [-p.detune, p.detune]) {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.06 / (1 + i * 0.4);
        const trem = ctx.createOscillator();
        trem.frequency.value = 0.07 + i * 0.031;
        const tg = ctx.createGain();
        tg.gain.value = 0.03 / (1 + i * 0.4);
        trem.connect(tg).connect(g.gain);
        o.connect(g).connect(filter);
        o.start(); trem.start();
        nodes.push(o, trem);
      }
    });
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    n.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = p.noise;
    n.connect(ng).connect(filter);
    n.start();
    nodes.push(n);
    lfo.start();
    this.bed = { gain, nodes };
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.2, slideTo?: number, delay = 0) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private whoosh(dur = 1.2, vol = 0.35, from = 200, to = 4000) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + dur);
  }

  sfx(kind: 'ok' | 'fail' | 'spawn' | 'portal' | 'warp' | 'select' | 'photon' | 'thunder' | 'push' | 'speak' | 'menu') {
    if (!this.enabled) return;
    switch (kind) {
      case 'ok': this.tone(660, 0.25, 'sine', 0.12); this.tone(990, 0.35, 'sine', 0.08, undefined, 0.06); break;
      case 'fail': this.tone(220, 0.35, 'triangle', 0.14, 160); break;
      case 'select': this.tone(1200, 0.12, 'sine', 0.08); break;
      case 'menu': this.tone(520, 0.2, 'sine', 0.1, 780); break;
      case 'speak': this.tone(880, 0.08, 'sine', 0.05); break;
      case 'spawn': this.tone(220, 0.9, 'sine', 0.18, 880); this.tone(330, 1.1, 'triangle', 0.08, 1320, 0.05); this.whoosh(0.8, 0.15, 400, 6000); break;
      case 'portal': this.tone(110, 2.0, 'sawtooth', 0.06, 440); this.tone(165, 2.0, 'sine', 0.12, 660); this.whoosh(1.8, 0.25, 100, 2000); break;
      case 'warp': this.whoosh(1.8, 0.45, 80, 8000); this.tone(55, 1.8, 'sine', 0.3, 220); break;
      case 'photon': this.tone(2400, 0.5, 'sine', 0.1, 4800); break;
      case 'push': this.whoosh(0.5, 0.4, 2000, 200); break;
      case 'thunder': {
        if (!this.ctx || !this.master) return;
        const ctx = this.ctx, t = ctx.currentTime;
        const n = ctx.createBufferSource();
        n.buffer = this.noiseBuffer();
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 300;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.9, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 3);
        n.connect(f).connect(g).connect(this.master);
        n.start(t); n.stop(t + 3);
        break;
      }
    }
  }
}
