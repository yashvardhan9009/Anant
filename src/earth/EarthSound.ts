/** Quiet synthesized wind, not a recording of the selected location. */
export class EarthSound {
  enabled = false;
  private ctx?: AudioContext;
  private source?: AudioBufferSourceNode;
  private gain?: GainNode;
  private filter?: BiquadFilterNode;
  private pan?: StereoPannerNode;
  async toggle() {
    if (!this.ctx) {
      try {
        const ctx = this.ctx = new AudioContext();
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 6, ctx.sampleRate), samples = buffer.getChannelData(0);
        let low = 0;
        for (let i = 0; i < samples.length; i++) { low = (low + .02 * (Math.random()*2-1))/1.02; samples[i] = low * 4; }
        this.source = ctx.createBufferSource(); this.source.buffer = buffer; this.source.loop = true;
        this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 700;
        this.gain = ctx.createGain(); this.gain.gain.value = 0; this.pan = ctx.createStereoPanner();
        this.source.connect(this.filter).connect(this.pan).connect(this.gain).connect(ctx.destination); this.source.start();
      } catch { return false; }
    }
    await this.ctx.resume(); this.enabled = !this.enabled; return this.enabled;
  }
  update(speed: number, height: number, heading: number) {
    if (!this.ctx || !this.gain || !this.filter || !this.pan) return;
    const active = this.enabled && !document.hidden && height < 30000;
    const air = Math.min(1, speed / 180);
    this.gain.gain.setTargetAtTime(active ? .1 + air * .23 : 0, this.ctx.currentTime, .4);
    this.filter.frequency.setTargetAtTime(450 + air * 1300, this.ctx.currentTime, .3);
    this.pan.pan.setTargetAtTime(Math.sin(heading) * .25, this.ctx.currentTime, .5);
  }
  dispose() { this.source?.stop(); void this.ctx?.close(); }
}
