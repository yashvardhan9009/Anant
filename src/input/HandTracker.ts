/**
 * Webcam hand tracking (MediaPipe Hand Landmarker, runs locally in the browser
 * via WASM/GPU — no video ever leaves the machine). Produces GestureEvents.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { GestureEngine, GestureEvent, HandFrame, LM } from '../../shared/gestures';

const LOCAL_MODEL = '/models/hand_landmarker.task';
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const CONNECTIONS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export class HandTracker {
  video = document.createElement('video');
  preview: HTMLCanvasElement;
  private lm?: HandLandmarker;
  private stream?: MediaStream;
  running = false;
  gestures = new GestureEngine();
  onEvents?: (ev: GestureEvent[], hands: HandFrame[]) => void;
  lastHands: HandFrame[] = [];
  /** average inference time per frame (ms), measured */
  inferMs = 0;
  detectFps = 0;
  private frames = 0;
  private fpsT = performance.now();
  private lastVideoTime = -1;

  constructor(previewHost: HTMLElement) {
    this.video.playsInline = true;
    this.video.muted = true;
    this.preview = document.createElement('canvas');
    this.preview.width = 320;
    this.preview.height = 240;
    this.preview.className = 'hand-preview';
    previewHost.appendChild(this.preview);
  }

  async start(): Promise<string> {
    if (this.running) return 'already running';
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.lm) {
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
      const opts = (model: string, delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO' as const,
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      const attempts: [string, 'GPU' | 'CPU'][] = [[LOCAL_MODEL, 'GPU'], [LOCAL_MODEL, 'CPU'], [CDN_MODEL, 'GPU'], [CDN_MODEL, 'CPU']];
      let lastErr: unknown;
      for (const [m, d] of attempts) {
        try {
          this.lm = await HandLandmarker.createFromOptions(fileset, opts(m, d));
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!this.lm) throw lastErr;
    }
    this.running = true;
    this.preview.classList.add('on');
    this.loop();
    return 'ok';
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.preview.classList.remove('on');
    this.onEvents?.(this.gestures.process([], performance.now()), []);
  }

  private loop = () => {
    if (!this.running || !this.lm) return;
    if (this.video.currentTime !== this.lastVideoTime && this.video.readyState >= 2) {
      this.lastVideoTime = this.video.currentTime;
      const t0 = performance.now();
      const res: any = this.lm.detectForVideo(this.video, t0);
      this.inferMs = this.inferMs * 0.9 + (performance.now() - t0) * 0.1;
      const hd = res.handedness ?? res.handednesses ?? [];
      const hands: HandFrame[] = (res.landmarks ?? []).map((lm: LM[], i: number) => ({
        landmarks: lm,
        handedness: (hd[i]?.[0]?.categoryName ?? 'Right') as 'Left' | 'Right',
        score: hd[i]?.[0]?.score ?? 0,
      }));
      this.lastHands = hands;
      const ev = this.gestures.process(hands, t0);
      this.draw(hands);
      this.onEvents?.(ev, hands);
      this.frames++;
      if (t0 - this.fpsT > 1000) {
        this.detectFps = (this.frames * 1000) / (t0 - this.fpsT);
        this.frames = 0;
        this.fpsT = t0;
      }
    }
    requestAnimationFrame(this.loop);
  };

  private draw(hands: HandFrame[]) {
    const c = this.preview.getContext('2d')!;
    const w = this.preview.width, h = this.preview.height;
    c.save();
    c.scale(-1, 1);
    c.translate(-w, 0);
    c.globalAlpha = 0.55;
    c.drawImage(this.video, 0, 0, w, h);
    c.globalAlpha = 1;
    for (const hf of hands) {
      c.strokeStyle = hf.score >= this.gestures.opts.minScore ? '#7df9ff' : '#ff6b8a';
      c.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        c.beginPath();
        c.moveTo(hf.landmarks[a].x * w, hf.landmarks[a].y * h);
        c.lineTo(hf.landmarks[b].x * w, hf.landmarks[b].y * h);
        c.stroke();
      }
      c.fillStyle = '#ffffff';
      for (const p of hf.landmarks) c.fillRect(p.x * w - 1.5, p.y * h - 1.5, 3, 3);
    }
    c.restore();
    c.fillStyle = 'rgba(0,0,0,.5)';
    c.fillRect(0, h - 18, w, 18);
    c.fillStyle = '#cfe';
    c.font = '11px JetBrains Mono, monospace';
    c.fillText(`${this.gestures.pose.toUpperCase()} · ${this.inferMs.toFixed(1)} ms · ${this.detectFps.toFixed(0)} Hz`, 6, h - 5);
  }
}
