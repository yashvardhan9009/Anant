/** Minimal, cinematic HUD. All dynamic text is set via textContent unless it is engine-generated HTML. */
import type { InfoCard } from '../engine/Realm';
import type { DirectorReply, ObjectKind } from '../../shared/commands';
import type { ExecResult } from '../../shared/worldState';
import type { Health } from '../api';
import { NPC_BY_ID } from '../../shared/story';
import { escapeHtml } from '../realms/Village';
import { formatLength } from '../../shared/scale';
import { QUALITY, QUALITY_NAMES, type QualityName } from '../engine/quality';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

export const CREATE_OPTIONS: { kind: ObjectKind; label: string }[] = [
  { kind: 'floating_island', label: 'Floating island' }, { kind: 'castle', label: 'Castle' }, { kind: 'dragon', label: 'Dragon' }, { kind: 'crystal', label: 'Crystal' },
  { kind: 'sword', label: 'Glowing sword' }, { kind: 'tree', label: 'Tree' }, { kind: 'orb', label: 'Orb of light' }, { kind: 'tower', label: 'Wizard tower' },
];

const HINTS: Record<string, string[]> = {
  nexus: ['Take me inside an atom', 'Open a portal to space', 'Create a glowing crystal', 'Make the sky purple'],
  atom: ['Show me a water molecule', 'Take me inside the proton', 'Switch to a 2p orbital', 'Excite the electron to 3d', 'Open a portal to space'],
  cosmos: ['Make me large enough to hold the Sun', 'Let me grab the Sun', 'Undo', 'Show me thousands of galaxies', 'Take me to Andromeda', 'Show me a black hole'],
  village: ['Talk to Captain Ilsa', 'Create a floating island above the village', 'Summon a dragon', 'Make it night', 'Create a storm'],
  heavy: ['Speed up time', 'Make gravity 2 times stronger', 'Take me back to our universe'],
};

export class HUD {
  root = document.getElementById('hud')!;
  input: HTMLInputElement;
  mic: HTMLButtonElement;
  barIn: HTMLDivElement;
  feed: HTMLDivElement;
  hints: HTMLDivElement;
  card: HTMLDivElement;
  title: HTMLDivElement;
  observerEl: HTMLDivElement;
  badge: HTMLDivElement;
  aiPill: HTMLButtonElement;
  fpsEl: HTMLSpanElement;
  handPill: HTMLButtonElement;
  soundPill: HTMLButtonElement;
  worldsPill: HTMLButtonElement;
  earthPill: HTMLButtonElement;
  onEarth?: () => void;
  onImagine?: () => void;
  qualitySelect: HTMLSelectElement;
  private cinemaPill: HTMLButtonElement;
  private cinemaExit: HTMLButtonElement;
  worldsMenu: HTMLDivElement;
  cardPill: HTMLButtonElement;
  dialogue: HTMLDivElement;
  dlgLog: HTMLDivElement;
  dlgInput: HTMLInputElement;
  dlgName: HTMLElement;
  dlgRole: HTMLElement;
  portrait: HTMLDivElement;
  radial: HTMLDivElement;
  tip: HTMLDivElement;
  help: HTMLDivElement;
  banner: HTMLDivElement;
  handHost: HTMLDivElement;
  onSubmit?: (text: string) => void;
  onSay?: (text: string) => void;
  onAccuse?: () => void;
  onCloseDialogue?: () => void;
  onCreate?: (kind: ObjectKind) => void;
  onQuality?: (quality: QualityName) => void;
  private lastRealm?: string;
  private hot = -1;
  private detailsOpen = false;

  constructor() {
    const top = h('div', 'topbar');
    const brand = h('div', 'brand');
    brand.append(h('div', 'wordmark', 'ANANT'));
    this.title = h('div', 'realm-title', 'The Nexus');
    this.badge = h('div', 'mode-badge mode-hub', 'THE THRESHOLD');
    this.observerEl = h('div', 'observer-size', 'You: 1.70 m');
    this.observerEl.title = 'Your apparent size (not your mass). Try “make me smaller” or “make me large enough to hold the Sun”.';
    brand.append(this.title, this.badge, this.observerEl);
    const ctr = h('div', 'controls');
    this.fpsEl = h('span', 'fps');
    this.aiPill = h('button', 'pill');
    this.aiPill.innerHTML = '<span class="dot"></span><span class="lbl">AI: checking…</span>';
    this.handPill = h('button', 'pill');
    this.handPill.innerHTML = '✋ <span class="lbl">Hands</span>';
    this.handPill.title = 'Webcam hand tracking (G)';
    this.soundPill = h('button', 'pill on');
    this.soundPill.innerHTML = '♪ <span class="lbl">Sound</span>';
    this.worldsPill = h('button', 'pill');
    this.worldsPill.innerHTML = '◎ <span class="lbl">Worlds</span>';
    this.cardPill = h('button', 'pill');
    this.cardPill.innerHTML = 'ⓘ <span class="lbl">Reality card</span>';
    const helpPill = h('button', 'pill');
    helpPill.innerHTML = '? <span class="lbl">Help</span>';
    helpPill.onclick = () => this.toggleHelp();
    this.qualitySelect = h('select', 'pill quality-select');
    this.qualitySelect.setAttribute('aria-label', 'Visual quality');
    this.qualitySelect.title = 'Visual quality — saves your world and reloads';
    for (const name of QUALITY_NAMES) {
      const option = h('option', '', name[0].toUpperCase() + name.slice(1));
      option.value = name;
      this.qualitySelect.append(option);
    }
    this.qualitySelect.value = QUALITY.name;
    this.qualitySelect.onchange = () => this.onQuality?.(this.qualitySelect.value as QualityName);
    this.cinemaPill = h('button', 'pill', 'Cinema');
    this.cinemaPill.title = 'Hide the interface and labels (P). Escape to return.';
    this.cinemaPill.setAttribute('aria-pressed', 'false');
    this.cinemaPill.onclick = () => this.toggleCinema();
    this.cinemaExit = h('button', 'cinema-exit', 'Exit cinema · Esc');
    this.cinemaExit.hidden = true;
    this.cinemaExit.onclick = () => this.toggleCinema(false);
    document.body.append(this.cinemaExit);
    this.earthPill = h('button', 'pill', 'Explore Earth');
    this.earthPill.onclick = () => this.onEarth?.();
    const imagine = h('button', 'pill', 'Imagine');
    imagine.onclick = () => this.onImagine?.();
    ctr.append(imagine, this.earthPill, this.aiPill, this.qualitySelect, this.cinemaPill, this.handPill, this.soundPill, this.worldsPill, this.cardPill, helpPill, this.fpsEl);
    top.append(brand, ctr);

    this.banner = h('div', 'banner');
    this.worldsMenu = h('div', 'worlds');
    this.card = h('div', 'card');
    this.card.classList.add('collapsed');
    this.cardPill.onclick = () => {
      this.card.classList.toggle('collapsed');
      this.cardPill.classList.toggle('on', !this.card.classList.contains('collapsed'));
    };

    // Dock
    const dock = h('div', 'dock');
    this.feed = h('div', 'feed');
    this.barIn = h('div', 'bar-in');
    this.input = h('input');
    this.input.placeholder = 'Where will your imagination take you?';
    this.input.setAttribute('aria-label', 'Intention');
    this.mic = h('button', 'mic');
    this.mic.innerHTML = MIC;
    this.mic.title = 'Voice (hold V)';
    const go = h('button', 'go', 'Manifest');
    go.onclick = () => this.submit();
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
      if (e.key === 'Escape') this.input.blur();
      e.stopPropagation();
    });
    this.barIn.append(this.input, this.mic, go);
    this.hints = h('div', 'hints');
    dock.append(this.feed, this.hints, this.barIn);

    // Dialogue
    this.dialogue = h('div', 'dialogue');
    const head = h('div', 'dlg-head');
    this.portrait = h('div', 'portrait');
    const who = h('div', 'who');
    this.dlgName = h('b');
    this.dlgRole = h('span');
    who.append(this.dlgName, this.dlgRole);
    const close = h('button', 'close', '×');
    close.onclick = () => this.onCloseDialogue?.();
    head.append(this.portrait, who, close);
    this.dlgLog = h('div', 'dlg-log');
    const dIn = h('div', 'dlg-in');
    this.dlgInput = h('input');
    this.dlgInput.placeholder = 'Say something…';
    const send = h('button', '', 'Say');
    const say = () => {
      const v = this.dlgInput.value.trim();
      if (v) { this.dlgInput.value = ''; this.onSay?.(v); }
    };
    send.onclick = say;
    this.dlgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') say();
      if (e.key === 'Escape') this.onCloseDialogue?.();
      e.stopPropagation();
    });
    dIn.append(this.dlgInput, send);
    const actions = h('div', 'dlg-actions');
    for (const q of ['What happened to the crown?', 'Did you see anything last night?', 'Who grows moonleaf?', 'I want to help.']) {
      const b = h('button', '', q);
      b.onclick = () => this.onSay?.(q);
      actions.append(b);
    }
    const acc = h('button', 'danger', 'Accuse of theft…');
    acc.onclick = () => this.onAccuse?.();
    actions.append(acc);
    this.dialogue.append(head, this.dlgLog, dIn, actions);

    // Radial creation menu
    this.radial = h('div', 'radial');
    this.radial.append(h('div', 'center', 'CREATE'));
    CREATE_OPTIONS.forEach((o, i) => {
      const a = (i / CREATE_OPTIONS.length) * Math.PI * 2 - Math.PI / 2;
      const e = h('div', 'opt', o.label);
      e.style.left = `${150 + Math.cos(a) * 112}px`;
      e.style.top = `${150 + Math.sin(a) * 112}px`;
      this.radial.append(e);
    });
    this.tip = h('div', 'tip');
    this.help = h('div', 'sheet');
    this.help.innerHTML = `<div class="inner"><button class="close">Close (H)</button><h2>How to experience ANANT</h2><p class="muted">Say or type what you want. Use your hands (✋ button), or mouse and keyboard.</p>
      <div class="cols">
        <table><tr><td colspan=2 style="color:var(--violet)">HAND GESTURES (webcam)</td></tr>
        <tr><td>Pinch</td><td>Grab an object / talk to a villager / enter a portal</td></tr><tr><td>Pinch + move</td><td>Move the grabbed object (pinch empty space to look around)</td></tr>
        <tr><td>Pinch + roll wrist</td><td>Rotate it</td></tr><tr><td>Two-hand pinch, spread</td><td>Scale the selection (or the atom)</td></tr>
        <tr><td>Hold open palm</td><td>Open the creation menu</td></tr><tr><td>Point &amp; draw a circle</td><td>Open a portal</td></tr><tr><td>Push palm forward</td><td>Apply a force</td></tr></table>
        <table><tr><td colspan=2 style="color:var(--violet)">MOUSE &amp; KEYBOARD</td></tr>
        <tr><td>Drag</td><td>Look / orbit (above &amp; below)</td></tr><tr><td>WASD / arrows</td><td>Move (Shift = fast)</td></tr><tr><td>C</td><td>Free-fly POV camera (E/Q up/down)</td></tr><tr><td>Wheel</td><td>Zoom · in the atom: powers of ten, from liquid water to the proton</td></tr>
        <tr><td>Click</td><td>Select · talk · enter portal</td></tr><tr><td>Drag object</td><td>Move it</td></tr><tr><td>Shift+wheel / [ ]</td><td>Scale selection (or atom)</td></tr>
        <tr><td>Alt+wheel / R</td><td>Rotate selection</td></tr><tr><td>Right-drag a circle</td><td>Open a portal</td></tr><tr><td>Space</td><td>Creation menu</td></tr>
        <tr><td>Shift+drag a planet</td><td>Grab &amp; move it (pinch with hands)</td></tr><tr><td>Z · X</td><td>Shrink · grow yourself</td></tr><tr><td>F</td><td>Push force</td></tr><tr><td>Del</td><td>Delete selection</td></tr><tr><td>T · V</td><td>Type · hold to talk</td></tr><tr><td>\`</td><td>FPS / latency overlay</td></tr></table>
        <table><tr><td colspan=2 style="color:var(--violet)">TRY SAYING</td></tr>
        <tr><td>Atom</td><td>“Show me the 1s orbital” · “Switch to 3d_xy” · “Excite the electron to 4f” · “Drop it back to the ground state”</td></tr>
        <tr><td>Cosmos</td><td>“Create a binary star” · “Make the third planet twice as massive” · “Add a planet at 3 AU” · “Show me a black hole”</td></tr>
        <tr><td>Story</td><td>“Talk to Doran” · ask about the crown, the night, moonleaf · “Accuse Seren”</td></tr>
        <tr><td>Create</td><td>“Create a castle” · “Put the castle on the floating island” · “Make gravity weaker” · “Freeze time”</td></tr></table>
      </div></div>`;
    (this.help.querySelector('.close') as HTMLButtonElement).onclick = () => this.toggleHelp(false);
    this.help.addEventListener('click', (e) => e.target === this.help && this.toggleHelp(false));
    this.handHost = h('div');
    this.root.append(top, this.banner, this.card, dock, this.dialogue, this.worldsMenu, this.handHost);
    document.body.append(this.radial, this.tip, this.help);
  }

  submit() {
    const v = this.input.value.trim();
    if (!v) return;
    this.input.value = '';
    this.onSubmit?.(v);
  }

  setBusy(b: boolean) {
    this.barIn.classList.toggle('busy', b);
  }

  toggleHelp(force?: boolean) {
    this.help.classList.toggle('open', force);
  }

  toggleCinema(force?: boolean) {
    const enabled = document.body.classList.toggle('cinema', force);
    this.root.inert = enabled;
    this.cinemaExit.hidden = !enabled;
    this.cinemaPill.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      this.help.classList.remove('open');
      this.radial.classList.remove('open');
      this.cinemaExit.focus();
    } else this.cinemaPill.focus();
  }

  setAi(hh: Health | null) {
    const dot = this.aiPill.querySelector('.dot')!;
    const lbl = this.aiPill.querySelector('.lbl')!;
    if (!hh) {
      dot.className = 'dot';
      lbl.textContent = 'Server unreachable — local only';
      return;
    }
    if (hh.ai.live) {
      dot.className = 'dot live';
      lbl.textContent = `AI · ${hh.ai.model?.replace(/^nvidia\//, '')}`;
      this.aiPill.title = `Live inference on ${hh.ai.provider}`;
    } else {
      dot.className = 'dot offline';
      lbl.textContent = hh.ai.mode === 'configured-but-unreachable' ? 'AI unavailable · offline' : 'OFFLINE PARSER';
      this.aiPill.title = 'The Director is running the deterministic local parser. Configure local Ollama or a Nebius API key on the server for live inference.';
    }
  }

  setObserver(m: number) {
    this.observerEl.textContent = `You: ${formatLength(m)}`;
  }

  setRealm(info: InfoCard, realm: string) {
    this.title.textContent = info.title;
    this.badge.textContent = info.mode;
    this.badge.className = `mode-badge ${info.mode.startsWith('SCI') ? 'mode-sci' : info.mode.startsWith('IMAG') ? 'mode-img' : info.mode.startsWith('HYP') ? 'mode-hyp' : 'mode-hub'}`;
    const acc = info.accuracy.map((a) => `<span class="tag tag-${a.tag}">${a.tag}</span><span>${escapeHtml(a.text)}</span>`).join('');
    const stats = info.stats.map((s) => `<span>${escapeHtml(s.label)}</span><span>${escapeHtml(s.value)}</span>`).join('');
    this.card.innerHTML = `<h3>${escapeHtml(info.title)}</h3><p class="sub">${escapeHtml(info.subtitle)}</p><h4>What you are seeing</h4><div class="acc">${acc}</div><div class="stats">${stats}</div>${info.extraHtml ? `<details${this.detailsOpen ? ' open' : ''}><summary>Data &amp; diagrams</summary>${info.extraHtml}</details>` : ''}`;
    const d = this.card.querySelector('details');
    d?.addEventListener('toggle', () => (this.detailsOpen = d.open));
    if (realm !== this.lastRealm) this.hints.replaceChildren(...(HINTS[realm] ?? []).map((t) => {
      const b = h('button', 'hint', t);
      b.onclick = () => this.onSubmit?.(t);
      return b;
    }));
    this.lastRealm = realm;
  }

  user(text: string) {
    this.feed.append(h('div', 'entry user', text));
    this.trimFeed();
  }

  /** Render a Director reply with each command's *confirmed* engine result. */
  reply(r: DirectorReply, results: { op: string; result: ExecResult }[]) {
    const e = h('div', 'entry');
    const src = h('div', 'src');
    if (r.source !== 'local-parser') {
      src.innerHTML = `<span class="live">● ${r.source === 'local-ai' ? 'LOCAL AI' : 'NEMOTRON'}</span><span>${escapeHtml(r.model ?? '')}</span><span>${r.latencyMs ?? '?'} ms</span>`;
    } else {
      src.innerHTML = `<span class="offline">● OFFLINE PARSER</span><span>${escapeHtml(r.fallbackReason ?? 'rule-based fallback')}</span>`;
    }
    e.append(src);
    if (r.narration) e.append(h('div', 'narr', r.narration));
    for (const { op, result } of results) {
      const row = h('div', `res ${result.ok ? 'ok' : 'fail'}`);
      row.append(h('span', 'ic', result.ok ? '✓' : '✗'), h('span', '', result.message), h('span', 'op', op));
      e.append(row);
    }
    for (const i of r.issues) {
      const row = h('div', 'res warn');
      row.append(h('span', 'ic', '!'), h('span', '', `Rejected an invalid command from the model (${i.op ?? '?'}): ${i.error}`));
      e.append(row);
    }
    for (const u of r.unsupported) {
      const row = h('div', 'res warn');
      row.append(h('span', 'ic', '⚠'), h('span', '', u.reason));
      e.append(row);
      if (u.suggestion) {
        const sDiv = h('div');
        const quoted = [...u.suggestion.matchAll(/[“"]([^”"]{3,80})[”"]/g)].map((m) => m[1]);
        if (quoted.length) for (const q of quoted) {
          const b = h('span', 'sugg', q);
          b.onclick = () => this.onSubmit?.(q);
          sDiv.append(b);
        }
        else sDiv.append(h('span', 'muted', u.suggestion));
        e.append(sDiv);
      }
    }
    if (!results.length && !r.unsupported.length && !r.narration && !r.issues.length) e.append(h('div', 'res warn', 'Nothing to do.'));
    this.feed.append(e);
    this.trimFeed();
  }

  system(text: string, kind: 'ok' | 'fail' | 'warn' = 'ok') {
    const e = h('div', 'entry');
    const row = h('div', `res ${kind}`);
    row.append(h('span', 'ic', kind === 'ok' ? '✓' : kind === 'fail' ? '✗' : '⚠'), h('span', '', text));
    e.append(row);
    this.feed.append(e);
    this.trimFeed();
  }

  private trimFeed() {
    while (this.feed.children.length > 6) this.feed.firstChild!.remove();
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  openDialogue(npcId: string) {
    const n = NPC_BY_ID[npcId];
    this.dlgName.textContent = n.name;
    this.dlgRole.textContent = n.role;
    this.portrait.textContent = n.name.split(' ').pop()![0];
    this.portrait.style.background = n.color;
    this.portrait.style.color = n.color;
    this.dialogue.classList.add('open');
    this.dlgLog.replaceChildren();
    setTimeout(() => this.dlgInput.focus(), 50);
  }

  closeDialogue() {
    this.dialogue.classList.remove('open');
  }

  dialogueLine(speaker: 'npc' | 'player', text: string, meta?: string) {
    const d = h('div', `dlg-line ${speaker}`, text);
    if (meta) d.append(h('span', 'meta', meta));
    this.dlgLog.append(d);
    this.dlgLog.scrollTop = this.dlgLog.scrollHeight;
    return d;
  }

  openRadial(x: number, y: number) {
    this.radial.style.left = `${x}px`;
    this.radial.style.top = `${y}px`;
    this.radial.classList.add('open');
    this.hot = -1;
  }
  radialOpen() {
    return this.radial.classList.contains('open');
  }
  radialHover(x: number, y: number) {
    const r = this.radial.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = Math.hypot(x - cx, y - cy);
    const opts = [...this.radial.querySelectorAll('.opt')];
    this.hot = -1;
    if (d > 50 && d < 190) {
      let a = Math.atan2(y - cy, x - cx) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      this.hot = Math.round((a / (Math.PI * 2)) * CREATE_OPTIONS.length) % CREATE_OPTIONS.length;
    }
    opts.forEach((o, i) => o.classList.toggle('hot', i === this.hot));
  }
  radialCommit(x: number, y: number) {
    this.radialHover(x, y);
    const k = this.hot >= 0 ? CREATE_OPTIONS[this.hot].kind : undefined;
    this.radial.classList.remove('open');
    if (k) this.onCreate?.(k);
  }
  closeRadial() {
    this.radial.classList.remove('open');
  }

  tooltip(text: string | null, x = 0, y = 0) {
    if (!text) { this.tip.style.display = 'none'; return; }
    this.tip.textContent = text;
    this.tip.style.display = 'block';
    this.tip.style.left = `${x + 16}px`;
    this.tip.style.top = `${y + 12}px`;
  }

  showBanner(text: string | null) {
    this.banner.textContent = text ?? '';
    this.banner.classList.toggle('show', !!text);
  }
}
