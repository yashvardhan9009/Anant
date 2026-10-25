/** Web Speech API wrappers: push-to-talk recognition and in-character speech synthesis. Both optional. */
export class Voice {
  private rec?: any;
  listening = false;
  supported: boolean;
  speakEnabled = true;
  onResult?: (text: string, final: boolean) => void;
  onState?: (listening: boolean) => void;

  constructor() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.supported = !!SR;
    if (SR) {
      this.rec = new SR();
      this.rec.lang = 'en-US';
      this.rec.interimResults = true;
      this.rec.continuous = false;
      this.rec.onresult = (e: any) => {
        let text = '', final = false;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          if (e.results[i].isFinal) final = true;
        }
        this.onResult?.(text.trim(), final);
      };
      this.rec.onend = () => { this.listening = false; this.onState?.(false); };
      this.rec.onerror = () => { this.listening = false; this.onState?.(false); };
    }
  }

  start() {
    if (!this.rec || this.listening) return;
    try { this.rec.start(); this.listening = true; this.onState?.(true); } catch {}
  }
  stop() {
    if (!this.rec || !this.listening) return;
    try { this.rec.stop(); } catch {}
  }

  speak(text: string, opts: { pitch?: number; rate?: number } = {}) {
    if (!this.speakEnabled || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.pitch = opts.pitch ?? 1;
      u.rate = opts.rate ?? 1;
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      if (voices.length) u.voice = voices[Math.floor((opts.pitch ?? 1) * 7) % voices.length];
      speechSynthesis.speak(u);
    } catch {}
  }
}
