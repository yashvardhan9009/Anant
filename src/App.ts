/**
 * App: the experience loop.
 *   intention → Director (Nemotron | offline parser) → validated commands →
 *   reducer (authoritative state) → engine render/transition → confirmed feedback → persistence
 */
import * as THREE from 'three';
import { Engine, PickResult } from './engine/Engine';
import { HUD } from './ui/HUD';
import { Audio } from './audio/Audio';
import { Voice } from './voice';
import { HandTracker } from './input/HandTracker';
import { InputRouter, InputHost } from './input/InputRouter';
import { api, Health } from './api';
import { Command, DirectorReply, REALMS, RealmId, ObjectKind, REALM_INFO } from '../shared/commands';
import { createWorld, execute, ExecResult, WorldState, Vec3 } from '../shared/worldState';
import { parseIntent } from '../shared/localParser';
import { applyDialogue, NPC_BY_ID, FACT_BY_ID } from '../shared/story';
import { Cosmos } from './realms/Cosmos';
import { Village } from './realms/Village';
import { Atom } from './realms/Atom';
import { assets } from './engine/assets';
import { QUALITY, QUALITY_KEY } from './engine/quality';
import { isExperienceIntent } from '../shared/experience';

const LS_KEY = 'anant.world.v1';
const ACTIVE_WORLD_KEY = 'anant.activeWorld.v1';
/** Operations that change the world enough to deserve an undo step. */
const UNDOABLE = new Set(['cosmos_black_hole', 'cosmos_move_body', 'cosmos_set_body', 'cosmos_add_body', 'cosmos_remove_body', 'cosmos_create_system', 'reset_system', 'set_gravity', 'spawn_object', 'delete_object', 'transform_object', 'set_object_property', 'set_environment', 'atom_set_orbital', 'atom_transition', 'cosmos_set_mode']);
const JOURNEY: RealmId[] = ['atom', 'cosmos', 'village', 'nexus'];
const REALM_COLOR: Record<RealmId, string> = { nexus: '#b388ff', atom: '#7df9ff', cosmos: '#ffd27d', village: '#ff9a6b', heavy: '#ff6bd5' };

export class App implements InputHost {
  engine: Engine;
  hud = new HUD();
  audio = new Audio();
  voice = new Voice();
  hands: HandTracker;
  input: InputRouter;
  state: WorldState;
  health: Health | null = null;
  serverOk = true;
  private queue: Promise<unknown> = Promise.resolve();
  private saveTimer?: number;
  private lastSaveOk = true;
  private grab?: { id: string; offset: THREE.Vector3; point: THREE.Vector3; before: WorldState };
  private pending: { scale?: number; rot?: number; atomScale?: number; timer?: number; target?: string; before?: WorldState } = {};
  private menuAt = { x: 0, y: 0 };
  private cardTimer = 0;
  private showPerf = false;
  lastDirectorMs?: number;
  private undoStack: { state: WorldState; label: string }[] = [];
  private redoStack: { state: WorldState; label: string }[] = [];
  private bodyGrab?: { id: string; planeY: number };
  private worldGeneration = 0;
  private earth?: import('./earth/EarthExplorer').EarthExplorer;
  private studio?: import('./experience/ExperienceStudio').ExperienceStudio;
  private earthResume?: import('./earth/EarthExplorer').EarthView;
  private openingStudio = false;
  private openingEarth = false;

  constructor() {
    this.engine = new Engine(document.getElementById('stage')!);
    this.state = createWorld('My Universe');
    this.hands = new HandTracker(this.hud.handHost);
    this.input = new InputRouter(this, this.engine.renderer.domElement);
    this.hands.onEvents = (ev, hands) => this.input.handleGestures(ev, hands);

    this.hud.onSubmit = (t) => this.intention(t);
    this.hud.onEarth = () => void this.openEarth();
    this.hud.onImagine = () => void this.openStudio();
    this.hud.onSay = (t) => this.say(t);
    this.hud.onCloseDialogue = () => this.closeDialogue();
    this.hud.onAccuse = () => this.accuseCurrent();
    this.hud.onCreate = (k) => this.createAtMenu(k);
    this.hud.onQuality = async (quality) => {
      this.hud.qualitySelect.disabled = true;
      await this.queue;
      if (!await this.persist(true)) {
        this.hud.qualitySelect.disabled = false;
        this.hud.qualitySelect.value = QUALITY.name;
        this.hud.system('Could not save your world. Quality was not changed.', 'fail');
        return;
      }
      try { localStorage.setItem(QUALITY_KEY, quality); } catch {}
      const url = new URL(location.href);
      url.searchParams.delete('lowfx');
      url.searchParams.set('quality', quality);
      url.searchParams.set('skipIntro', '');
      location.assign(url.href);
    };
    this.hud.handPill.onclick = () => this.toggleHands();
    this.hud.soundPill.onclick = () => {
      this.audio.setEnabled(!this.audio.enabled);
      this.voice.speakEnabled = this.audio.enabled;
      this.hud.soundPill.classList.toggle('on', this.audio.enabled);
    };
    this.hud.worldsPill.onclick = () => this.toggleWorlds();
    this.hud.mic.onpointerdown = () => this.voice.start();
    this.hud.mic.onpointerup = () => this.voice.stop();
    this.voice.onState = (on) => this.hud.mic.classList.toggle('on', on);
    this.voice.onResult = (text, final) => {
      this.hud.input.value = text;
      if (final && text) {
        this.hud.input.value = '';
        if (this.state.story.activeConversation && this.state.activeRealm === 'village') this.say(text);
        else this.intention(text);
      }
    };
    if (!this.voice.supported) this.hud.mic.title = 'Voice input is not supported in this browser — type instead';

    this.engine.onPortalCross = (id) => this.run([{ op: 'enter_portal', portal: id }], 'walk');
    this.engine.onFrame = (dt) => this.frame(dt);
    this.engine.rig.onStep = running => { this.audio.start(); this.audio.step(running); };
    (this.engine.realms.atom as Atom).onViewMode = (mode) => {
      const rig = this.engine.rig;
      if (this.engine.active !== 'atom' || this.engine.transitioning) return;
      if (mode === 'field' && rig.mode !== 'fly') {
        rig.setFly();
        this.hud.system('You are now swimming through liquid water. Fly with WASD · E/Q up/down · drag to look · click a hydrogen to dive in · Z/X shrink/grow.', 'ok');
      } else if (mode === 'quantum' && rig.mode === 'fly') {
        rig.setOrbit(new THREE.Vector3(), rig.camera.position.clone().normalize().multiplyScalar(16));
        rig.update(0, this.engine.realms.atom);
        rig.setFly();
      }
    };
    const village = this.engine.realms.village as Village;
    village.onApproach = (id) => {
      if (!this.state.story.activeConversation) this.run([{ op: 'talk_to', npc: id }], 'npc');
    };
    for (const r of Object.values(this.engine.realms)) {
      r.objects.onRest = (id, pos) => {
        const o = this.state.objects.find((x) => x.id === id);
        if (o && o.position.some((v, i) => Math.abs(v - pos[i]) > 1e-3)) this.commit({ op: 'transform_object', target: id, move_to: pos });
      };
      const w = (r as any).weather;
      if (w) w.onThunder = () => this.audio.sfx('thunder');
    }
    (window as any).__anant = this;
  }

  // ———————————————————————————————— lifecycle ————————————————————————————————

  async boot() {
    await assets.init();
    try {
      this.health = await api.health();
      this.serverOk = true;
    } catch {
      this.health = null;
      this.serverOk = false;
    }
    this.hud.setAi(this.health);
    let loaded: WorldState | undefined;
    let activeId: string | null = null;
    try { activeId = localStorage.getItem(ACTIVE_WORLD_KEY); } catch {}
    if (this.serverOk) {
      try {
        const { worlds } = await api.listWorlds();
        const selected = worlds.find(w => w.id === activeId) ?? worlds[0];
        if (selected) loaded = (await api.loadWorld(selected.id)).world;
      } catch {}
    }
    // A save can fall back to the browser while the server is temporarily down.
    // Recover that newer snapshot even when the server is reachable on reload.
    try {
      const raw = localStorage.getItem(LS_KEY);
      const local: WorldState | undefined = raw ? JSON.parse(raw) : undefined;
      if (local?.schema === 1 && (!loaded ||
          (local.id === loaded.id && local.updatedAt > loaded.updatedAt) ||
          (local.id === activeId && loaded.id !== activeId))) loaded = local;
    } catch {}
    if (!this.serverOk) {
      this.hud.showBanner('Server unreachable — using the offline parser and saving in this browser only.');
    }
    this.loadWorld(loaded ?? createWorld('My Universe'), !!loaded);
    this.engine.start();
    if (new URLSearchParams(location.search).has('studio')) void this.openStudio();
    else if (new URLSearchParams(location.search).has('earth')) void this.openEarth();
  }

  loadWorld(w: WorldState, resumed = false) {
    this.worldGeneration++;
    clearTimeout(this.saveTimer);
    clearTimeout(this.pending.timer);
    this.pending = {};
    this.grab = undefined;
    this.bodyGrab = undefined;
    this.undoStack = [];
    this.redoStack = [];
    // A saved snapshot may have the same revision counters as another world.
    for (const r of Object.values(this.engine.realms)) r.resetForWorld();
    w = structuredClone(w);
    w.cosmos.grabbed = undefined;
    w.observer ??= { size: 1.7 }; // worlds saved before the scale engine existed
    w.env.heavy ??= { weather: 'clear', timeOfDay: 'night', fog: 0, gravity: 1 }; // worlds saved before the multiverse
    this.state = w;
    try { localStorage.setItem(ACTIVE_WORLD_KEY, w.id); } catch {}
    const e = this.engine;
    e.state = w;
    for (const r of Object.values(e.realms)) (r as any).built && r.scene.traverse((o: any) => o.isCSS2DObject && (o.element.style.display = 'none'));
    e.active = w.activeRealm;
    e.realm.ensureBuilt();
    e.renderPass.scene = e.realm.scene;
    e.sync(w);
    e.placeCameraOnArrival(w.activeRealm);
    e.realm.onEnter(w);
    this.hud.closeDialogue();
    this.refreshCard();
    this.audio.ambience(w.activeRealm);
    this.applyObserverFor(w.activeRealm);
    if (resumed) {
      const n = w.objects.length, d = w.story.transcript.filter((t) => t.speaker === 'player').length;
      this.hud.system(`Welcome back to “${w.name}”. Resumed in ${REALM_INFO[w.activeRealm].title} — ${n} creation${n === 1 ? '' : 's'}, ${w.portals.length} portal${w.portals.length === 1 ? '' : 's'}, ${d} thing${d === 1 ? '' : 's'} said to villagers.`);
    }
  }

  private frame(dt: number) {
    this.input.draw();
    this.cardTimer += dt;
    if (this.cardTimer > 0.5) {
      this.cardTimer = 0;
      this.refreshCard();
      const f = this.engine.fps;
      this.hud.fpsEl.textContent = this.showPerf
        ? `${f.value.toFixed(0)} fps · cpu ${f.frameMs.toFixed(1)} ms${this.lastDirectorMs !== undefined ? ` · director ${this.lastDirectorMs} ms` : ''}${this.hands.running ? ` · hands ${this.hands.inferMs.toFixed(1)} ms @${this.hands.detectFps.toFixed(0)}Hz` : ''}`
        : `${f.value.toFixed(0)} fps`;
    }
  }

  /** Entering a realm: keep the observer's size where it makes sense, otherwise adopt the realm's natural scale. */
  private applyObserverFor(realm: RealmId) {
    if(realm==='cosmos' && this.state.cosmos.blackHole) {
      this.engine.rig.setOrbit(new THREE.Vector3(),new THREE.Vector3(-6,2.4,33));
      this.hud.setObserver(this.state.observer?.size??1.7);return;
    }
    const size = this.state.observer?.size ?? 1.7;
    const space = realm === 'cosmos' || realm === 'heavy';
    const natural = realm === 'atom' ? 1e-10 / this.state.atom.scale : space ? Math.max(size, 1.7) : 1.7;
    const fits = realm === 'atom' ? size < 1e-6 : space ? true : size >= 1e-6 && size <= 2e3;
    const use = fits ? size : natural;
    if (use !== size) this.state = { ...this.state, observer: { size: use } };
    if (!space || size > 2e3) this.engine.realm.applyObserver(use, this.engine.rig);
    this.hud.setObserver(use);
  }

  refreshCard() {
    const r = this.engine.realm;
    this.hud.setRealm(r.info(this.state), r.id);
  }

  // ———————————————————————————————— command execution ————————————————————————————————

  private ctx() {
    const rig = this.engine.rig;
    const realm = this.engine.realm;
    const f = rig.inFront(realm.id === 'village' ? 9 : 7);
    const y = realm.id === 'atom' || realm.id === 'cosmos' || realm.id === 'heavy' ? Math.max(1.5, this.engine.camera.position.y * 0.3) : realm.groundY(f.x, f.z) + 2;
    return { inFront: [+f.x.toFixed(2), +y.toFixed(2), +f.z.toFixed(2)] as Vec3, yaw: rig.facingYaw };
  }

  /** Execute ONE validated command and apply its engine side-effects. Returns the confirmed result. */
  private async exec(cmd: Command): Promise<ExecResult> {
    this.flushPending();
    if (cmd.op === 'undo' || cmd.op === 'redo') return this.undoRedo(cmd.op);
    const prevRealm = this.state.activeRealm;
    let base = this.state;
    if (cmd.op.startsWith('cosmos_') || cmd.op === 'save_world') base = this.withCosmosSnapshot(base);
    const { state, result } = execute(base, cmd, this.ctx());
    if (!result.ok) {
      this.audio.sfx('fail');
      return result;
    }
    if (UNDOABLE.has(cmd.op)) {
      this.pushUndo(base, result.message.slice(0, 80));
    }
    this.setState(state);
    switch (cmd.op) {
      case 'go_to_realm':
      case 'enter_portal': {
        const to = state.activeRealm;
        if (to !== prevRealm) {
          this.closeDialogue(true);
          this.audio.sfx('warp');
          await this.engine.transitionTo(to, cmd.op === 'enter_portal' ? (result.data?.portal as string) : undefined, REALM_COLOR[to]);
          this.audio.ambience(to);
          this.applyObserverFor(to);
          this.refreshCard();
        }
        break;
      }
      case 'cosmos_grab':
        if (!cmd.release) {
          this.bodyGrab = { id: state.cosmos.grabbed ?? cmd.target ?? '', planeY: 0 };
          this.pushUndo(base, `Moved ${state.cosmos.grabbed}`);
        } else this.releaseBody();
        break;
      case 'go_to_object': {
        if (state.activeRealm !== prevRealm) {
          this.closeDialogue(true);
          this.audio.sfx('warp');
          await this.engine.transitionTo('cosmos', undefined, '#ffd27d');
          this.audio.ambience('cosmos');
        }
        (this.engine.realms.cosmos as Cosmos).applyObserver(state.observer.size, this.engine.rig, cmd.name);
        this.hud.setObserver(state.observer.size);
        this.refreshCard();
        break;
      }
      case 'set_scale': {
        const to = state.activeRealm;
        if (to !== prevRealm) {
          this.closeDialogue(true);
          this.audio.sfx('warp');
          await this.engine.transitionTo(to, undefined, (state.observer.size < (this.state.observer?.size ?? 1.7) ? '#7df9ff' : '#ffd27d'));
          this.audio.ambience(to);
        }
        this.engine.realm.applyObserver(state.observer.size, this.engine.rig);
        this.refreshCard();
        break;
      }
      case 'open_portal': this.audio.sfx('portal'); break;
      case 'spawn_object': this.audio.sfx('spawn'); break;
      case 'atom_transition': this.audio.sfx('photon'); break;
      case 'cosmos_black_hole':
        // cinematic framing: just above the plane of the accretion disk
        if (cmd.show) this.engine.rig.setOrbit(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-6, 2.4, 33));
        else this.engine.placeCameraOnArrival('cosmos');
        break;
      case 'talk_to': this.openDialogue(cmd.npc === result.data?.npc ? cmd.npc : (result.data?.npc as string)); break;
      case 'accuse': this.hud.dialogueLine('npc', result.message, 'story consequence'); break;
      case 'save_world': {
        const ok = await this.persist(true);
        return ok ? { ...result, message: `Saved “${this.state.name}” to ${this.serverOk ? 'the server (SQLite)' : 'this browser'}.` } : { ok: false, op: cmd.op, message: 'Saving failed — your changes are still in memory.' };
      }
    }
    if (cmd.op !== 'go_to_realm' && cmd.op !== 'enter_portal') this.audio.sfx('ok');
    return result;
  }

  /** Restore the previous/next world snapshot (the live simulation reloads from it). */
  private pushUndo(state: WorldState, label: string) {
    this.undoStack.push({ state, label });
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }

  private async undoRedo(op: 'undo' | 'redo'): Promise<ExecResult> {
    const from = op === 'undo' ? this.undoStack : this.redoStack;
    const to = op === 'undo' ? this.redoStack : this.undoStack;
    const entry = from.pop();
    if (!entry) return { ok: false, op, message: op === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' };
    const current = this.withCosmosSnapshot(this.state);
    to.push({ state: current, label: entry.label });
    const restored: WorldState = structuredClone(entry.state);
    this.bodyGrab = undefined;
    restored.cosmos.grabbed = undefined;
    restored.cosmos.epoch = Math.max(current.cosmos.epoch, restored.cosmos.epoch) + 1; // force the simulation to reload
    const prevRealm = this.state.activeRealm;
    this.setState(restored);
    if (restored.activeRealm !== prevRealm) await this.engine.transitionTo(restored.activeRealm, undefined, REALM_COLOR[restored.activeRealm]);
    this.applyObserverFor(restored.activeRealm);
    this.refreshCard();
    this.audio.sfx('ok');
    return { ok: true, op, message: `${op === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}` };
  }

  /** Run commands sequentially (serialised with any other running batch). */
  run(cmds: Command[], via: 'director' | 'walk' | 'npc' | 'gesture' = 'director'): Promise<{ op: string; result: ExecResult }[]> {
    const job = this.queue.then(async () => {
      const out: { op: string; result: ExecResult }[] = [];
      for (const c of cmds) {
        const result = await this.exec(c);
        out.push({ op: c.op, result });
        if (!result.ok && (c.op === 'go_to_realm' || c.op === 'enter_portal')) break; // later steps depended on travel
      }
      if (via !== 'director') for (const { result } of out) if (via !== 'npc' || !result.ok) this.hud.system(result.message, result.ok ? 'ok' : 'fail');
      return out;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /** Silent state commit for continuous manipulation (drag/scale/rotate/physics settle). */
  private commit(cmd: Command) {
    const { state, result } = execute(this.state, cmd, this.ctx());
    if (result.ok) this.setState(state);
    return result;
  }

  setState(s: WorldState) {
    this.state = s;
    if (s.observer) this.hud.setObserver(s.observer.size);
    this.engine.sync(s);
    this.scheduleSave();
  }

  private withCosmosSnapshot(s: WorldState): WorldState {
    const cos = this.engine.realms.cosmos as Cosmos;
    if (!(cos as any).built) return s;
    return { ...s, cosmos: { ...s.cosmos, bodies: cos.snapshotBodies(s.cosmos.bodies) } };
  }

  // ———————————————————————————————— intentions ————————————————————————————————

  async intention(text: string) {
    const t = text.trim();
    if (!t) return;
    const generation = this.worldGeneration;
    this.audio.start();
    this.hud.user(t);
    if (this.meta(t)) return;
    this.hud.setBusy(true);
    let reply: DirectorReply;
    const t0 = performance.now();
    try {
      reply = await api.director(t, this.withCosmosSnapshot(this.state));
      this.serverOk = true;
    } catch (e: any) {
      // Server down: the same deterministic parser runs in the browser, clearly labelled.
      const p = parseIntent(t, this.state);
      reply = { ...p, issues: [], source: 'local-parser', fallbackReason: `server unreachable (${e.message}) — in-browser parser`, latencyMs: Math.round(performance.now() - t0) };
      this.serverOk = false;
    }
    this.lastDirectorMs = Math.round(performance.now() - t0);
    this.hud.setBusy(false);
    if (generation !== this.worldGeneration) return; // a delayed reply belongs to the previous world
    if(!reply.commands.length&&reply.unsupported.length&&/^(create|make|build|summon|imagine|wish|turn)/i.test(t)){void this.openStudio(t);return;}
    const results = await this.run(reply.commands, 'director');
    this.hud.reply(reply, results);
    if (this.health && reply.source !== 'local-parser' && !this.health.ai.live) api.health().then((h) => this.hud.setAi((this.health = h))).catch(() => {});
  }

  /** UI-only requests that are not world operations. */
  private meta(t: string): boolean {
    const s = t.toLowerCase();
    if (isExperienceIntent(t)) { void this.openStudio(t); return true; }
    if (/^(explore earth|land on earth|open earth|google earth|earth explorer|show earth detail)/.test(s)) { void this.openEarth(); return true; }
    if (/^(help|\?|what can (i|you) do)/.test(s)) { this.hud.toggleHelp(true); return true; }
    if (/(the end|finale|end (the )?demo|experience the impossible)/.test(s)) { this.finale(); return true; }
    if (/^(enable|turn on|start) (hand|gesture)/.test(s)) { this.toggleHands(true); return true; }
    return false;
  }

  async openEarth() {
    if (this.earth || this.openingEarth || this.studio || this.openingStudio) return;
    this.openingEarth = true;
    this.hud.earthPill.disabled = true;
    try {
      const { EarthExplorer } = await import('./earth/EarthExplorer');
      this.engine.suspended = true;
      this.engine.rig.stopMotion(); this.audio.setSuspended(true);
      this.hud.toggleCinema(false);
      this.hud.root.inert = true;
      this.hud.root.setAttribute('aria-hidden', 'true');
      const stage = document.getElementById('stage')!;
      stage.inert = true;
      stage.setAttribute('aria-hidden', 'true');
      const restore = () => {
        this.earth?.dispose(); this.earth = undefined;
        this.engine.suspended = false; this.engine.rig.stopMotion(); this.audio.setSuspended(false);
        this.hud.root.inert = false; stage.inert = false;
        this.hud.root.removeAttribute('aria-hidden'); stage.removeAttribute('aria-hidden');
        this.hud.earthPill.focus();
      };
      this.earth = new EarthExplorer(restore, place => {
        this.earthResume = this.earth?.snapshot();
        restore();
        void this.openStudio('', place, true);
      });
      const explorer = this.earth;
      try {
        await explorer.start(this.earthResume);
        if (this.earth === explorer) this.earthResume = undefined;
      } catch (e) { restore(); throw e; }
    } catch {
      this.hud.system('Earth could not start. Please reload and try again.', 'fail');
    } finally {
      this.openingEarth = false;
      this.hud.earthPill.disabled = false;
    }
  }

  async openStudio(prompt = '', place = '', returnToEarth = false) {
    if (this.studio) { if (prompt) this.studio.setPrompt(prompt); return; }
    if (this.openingStudio || this.earth) return;
    this.openingStudio = true;
    const stage = document.getElementById('stage')!;
    const restore = () => {
      this.studio?.dispose();
      this.studio = undefined;
      this.engine.suspended = false;
      this.engine.rig.stopMotion();
      this.audio.setSuspended(false);
      this.hud.root.inert = false;
      stage.inert = false;
      this.hud.root.removeAttribute('aria-hidden');
      stage.removeAttribute('aria-hidden');
      this.hud.input.focus();
      if (returnToEarth) queueMicrotask(() => void this.openEarth());
    };
    try {
      const { ExperienceStudio } = await import('./experience/ExperienceStudio');
      this.engine.suspended = true;
      this.engine.rig.stopMotion();
      this.audio.setSuspended(true);
      this.voice.stop();
      this.closeDialogue(true);
      this.hud.toggleCinema(false);
      this.hud.root.inert = true;
      stage.inert = true;
      this.hud.root.setAttribute('aria-hidden', 'true');
      stage.setAttribute('aria-hidden', 'true');
      const generation = this.worldGeneration;
      this.studio = new ExperienceStudio(restore, reply => {
        if (generation === this.worldGeneration) this.setState({ ...this.state, experience: reply, updatedAt: Date.now() });
      }, this.state.experience, place);
      if (prompt) { this.studio.setPrompt(prompt); void this.studio.generate(); }
    } catch (e) {
      restore();
      this.hud.system(`Reality studio could not start: ${e instanceof Error ? e.message : 'unknown error'}`, 'fail');
    } finally { this.openingStudio = false; }
  }

  // ———————————————————————————————— story ————————————————————————————————

  private openDialogue(npcId: string) {
    const npc = NPC_BY_ID[npcId];
    this.hud.openDialogue(npcId);
    const past = this.state.story.transcript.filter((l) => l.npc === npcId).slice(-8);
    if (past.length) {
      this.hud.dialogueLine('npc', `(${npc.name} remembers you.)`, 'from saved memory');
      for (const l of past) this.hud.dialogueLine(l.speaker, l.text);
    } else {
      this.hud.dialogueLine('npc', npc.greeting, 'authored opening line');
      this.voice.speak(npc.greeting, npc.voice);
    }
  }

  private closeDialogue(silent = false) {
    this.hud.closeDialogue();
    if (this.state.story.activeConversation) {
      this.state = { ...this.state, story: { ...this.state.story, activeConversation: undefined } };
      if (!silent) this.engine.sync(this.state);
    }
  }

  async say(line: string) {
    const npcId = this.state.story.activeConversation;
    if (!npcId || this.state.activeRealm !== 'village') {
      this.intention(line);
      return;
    }
    const npc = NPC_BY_ID[npcId];
    this.hud.dialogueLine('player', line);
    const typing = this.hud.dialogueLine('npc', '', undefined);
    typing.classList.add('typing');
    try {
      const r = await api.npc(npcId, line, this.state.story, this.state.id);
      typing.remove();
      const before = new Set(this.state.story.playerKnows);
      const { story, accepted } = applyDialogue(this.state.story, npcId, line, r.outcome, r.source);
      this.setState({ ...this.state, story });
      const meta = r.source !== 'offline-dialogue' ? `${r.model ?? 'AI'} · ${r.latencyMs} ms · ${r.outcome.emotion}` : `offline dialogue (${r.fallbackReason ?? 'no model'})`;
      this.hud.dialogueLine('npc', r.outcome.speech, meta);
      this.voice.speak(r.outcome.speech, npc.voice);
      this.audio.sfx('speak');
      for (const f of accepted) if (!before.has(f)) this.hud.system(`Journal: ${FACT_BY_ID[f].text}`, 'ok');
      this.refreshCard();
    } catch (e: any) {
      typing.remove();
      this.hud.dialogueLine('npc', `(${npc.name} cannot hear you — the dialogue server is unreachable: ${e.message})`, 'error');
    }
  }

  private accuseCurrent() {
    const id = this.state.story.activeConversation;
    if (!id) return;
    if (!confirm(`Formally accuse ${NPC_BY_ID[id].name} of stealing the Ember Crown? This cannot be undone.`)) return;
    this.run([{ op: 'accuse', npc: id }], 'npc').then(() => this.refreshCard());
  }

  // ———————————————————————————————— InputHost ————————————————————————————————

  isTyping() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable);
  }

  pickAction(p: PickResult, via: 'mouse' | 'hand') {
    this.audio.start();
    if (this.state.cosmos.grabbed && this.state.activeRealm === 'cosmos') { this.releaseBody(); return; }
    if (p.portalId) this.run([{ op: 'enter_portal', portal: p.portalId }], 'gesture');
    else if (p.npcId) this.run([{ op: 'talk_to', npc: p.npcId }], 'npc');
    else if (p.gate) {
      const g = (this.engine.realms.nexus as any).gates.find((x: any) => x.userData.gate === p.gate) as THREE.Object3D;
      const pos = g.position.clone().multiplyScalar(0.82);
      const yaw = Math.atan2(-pos.x, -pos.z);
      const existing = this.state.portals.find((q) => q.from === 'nexus' && q.to === p.gate);
      if (existing) this.run([{ op: 'enter_portal', portal: existing.id }], 'gesture');
      else {
        const { state, result } = execute(this.state, { op: 'open_portal', to: p.gate, position: [+pos.x.toFixed(2), 2.6, +pos.z.toFixed(2)] }, { yaw });
        if (result.ok) { this.setState(state); this.audio.sfx('portal'); }
        this.hud.system(result.message, result.ok ? 'ok' : 'fail');
      }
    } else if (p.bodyId) this.run([{ op: 'camera_focus', target: p.bodyId }], 'gesture');
    else if (p.objectId) {
      this.commit({ op: 'select_object', target: p.objectId });
      this.audio.sfx('select');
    }
  }

  /** Pinch/drag on a celestial body: pick it up. */
  beginBodyGrab(id: string) {
    if (this.state.activeRealm !== 'cosmos') return false;
    const r = execute(this.state, { op: 'cosmos_grab', target: id });
    if (!r.result.ok) return false;
    this.pushUndo(this.withCosmosSnapshot(this.state), `Moved ${id}`);
    this.setState(r.state);
    this.bodyGrab = { id: r.state.cosmos.grabbed!, planeY: 0 };
    this.audio.sfx('select');
    return true;
  }

  /** Called per pointer/hand move while a body is held. */
  moveBody(ndc: THREE.Vector2) {
    if (!this.bodyGrab || this.state.activeRealm !== 'cosmos') return;
    const cos = this.engine.realms.cosmos as Cosmos;
    const cur = cos.focusPoint('body', this.bodyGrab.id);
    const hit = this.engine.rayToPlane(ndc, cur?.y ?? 0);
    if (!hit) return;
    cos.holdAt(this.bodyGrab.id, cos.displayToAU(this.bodyGrab.id, hit), (this.state.cosmos.mode ?? 'physics') === 'sandbox');
  }

  /** Drop the held body: commit its final position as a validated command. */
  releaseBody() {
    const g = this.bodyGrab ?? (this.state.cosmos.grabbed ? { id: this.state.cosmos.grabbed, planeY: 0 } : undefined);
    if (!g) return;
    this.bodyGrab = undefined;
    const cos = this.engine.realms.cosmos as Cosmos;
    const i = cos.sim.index(g.id);
    const snap = this.withCosmosSnapshot(this.state);
    let s = execute(snap, { op: 'cosmos_grab', release: true }).state;
    if (i >= 0) {
      const p = cos.sim.getPos(i);
      const r = execute(s, { op: 'cosmos_move_body', target: g.id, position: [+p[0].toFixed(5), +p[1].toFixed(5), +p[2].toFixed(5)] });
      if (r.result.ok) { s = r.state; this.hud.system(r.result.message, 'ok'); }
    }
    this.setState(s);
    this.audio.sfx('ok');
  }

  beginGrab(objectId: string, point: THREE.Vector3) {
    const e = this.engine.realm.objects.get(objectId);
    if (!e) return false;
    this.commit({ op: 'select_object', target: objectId });
    this.engine.realm.objects.grabbedId = objectId;
    e.moving = false;
    this.flushPending();
    this.grab = { id: objectId, offset: e.holder.position.clone().sub(point), point: point.clone(), before: this.withCosmosSnapshot(this.state) };
    this.audio.sfx('select');
    return true;
  }

  moveGrab(ndc: THREE.Vector2, depth: number) {
    if (!this.grab) return;
    const e = this.engine.realm.objects.get(this.grab.id);
    if (!e) return;
    if (depth) this.grab.point.addScaledVector(this.engine.rig.forward, -depth * 25);
    const p = this.engine.rayToFacingPlane(ndc, this.grab.point);
    if (!p) return;
    this.grab.point.copy(p);
    const pos = p.clone().add(this.grab.offset);
    const gy = this.engine.realm.groundY(pos.x, pos.z);
    if (this.engine.realm.id !== 'atom' && this.engine.realm.id !== 'cosmos' && this.engine.realm.id !== 'heavy') pos.y = Math.max(gy, pos.y);
    e.holder.position.copy(pos);
  }

  endGrab() {
    if (!this.grab) return;
    const layer = this.engine.realm.objects;
    const e = layer.get(this.grab.id);
    layer.grabbedId = undefined;
    if (e) {
      const p = e.holder.position;
      const old = this.grab.before.objects.find(o => o.id === this.grab!.id);
      if (old && p.distanceTo(new THREE.Vector3(...old.position)) > 0.001) this.pushUndo(this.grab.before, `Moved ${old.name}`);
      this.commit({ op: 'transform_object', target: this.grab.id, move_to: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)] });
    }
    this.grab = undefined;
  }

  scaleSelected(f: number) {
    const sel = this.state.selectedId && this.state.objects.find((o) => o.id === this.state.selectedId && o.realm === this.state.activeRealm);
    if (this.pending.target && this.pending.target !== (sel ? sel.id : undefined)) this.flushPending();
    const pend = this.pending;
    if (sel) {
      pend.before ??= this.withCosmosSnapshot(this.state);
      pend.target = sel.id;
      pend.scale = Math.min(50, Math.max(0.05, (pend.scale ?? sel.scale) * f));
      const e = this.engine.realm.objects.get(sel.id);
      if (e) e.obj = { ...e.obj, scale: pend.scale };
    } else if (this.state.activeRealm === 'atom') {
      pend.atomScale = Math.min(300000, Math.max(0.0005, (pend.atomScale ?? this.state.atom.scale) * f));
      (this.engine.realm as Atom as any).scaleTarget = pend.atomScale;
    } else return;
    this.flushPendingSoon();
  }

  rotateSelected(d: number) {
    const id = this.state.selectedId;
    const e = id ? this.engine.realm.objects.get(id) : undefined;
    if (!e) return;
    if (this.pending.target && this.pending.target !== id) this.flushPending();
    this.pending.before ??= this.withCosmosSnapshot(this.state);
    this.pending.target = id;
    this.pending.rot = (this.pending.rot ?? 0) + d;
    e.holder.rotation.y += d;
    this.flushPendingSoon();
  }

  private flushPendingSoon() {
    clearTimeout(this.pending.timer);
    this.pending.timer = window.setTimeout(() => this.flushPending(), 350);
  }

  private flushPending() {
    const p = this.pending;
    clearTimeout(p.timer);
    this.pending = {};
    const id = p.target;
    if (p.before && id) this.pushUndo(p.before, 'Resized or rotated object');
    if (p.scale !== undefined && id) this.commit({ op: 'transform_object', target: id, scale_to: +p.scale.toFixed(3) });
    if (p.rot !== undefined && id) this.commit({ op: 'transform_object', target: id, rotate_by: [0, +p.rot.toFixed(4), 0] });
    if (p.atomScale !== undefined) this.commit({ op: 'atom_set_view', scale: +p.atomScale.toPrecision(4) });
  }

  openCreateMenu(x: number, y: number) {
    this.menuAt = { x, y };
    this.hud.openRadial(x, y);
    this.audio.sfx('menu');
  }
  menuOpen() { return this.hud.radialOpen(); }
  menuHover(x: number, y: number) { this.hud.radialHover(x, y); }
  menuCommit(x: number, y: number) { this.hud.radialCommit(x, y); }
  closeMenus() {
    this.hud.closeRadial();
    this.hud.worldsMenu.classList.remove('open');
    this.hud.toggleHelp(false);
  }

  private createAtMenu(kind: ObjectKind) {
    const realm = this.engine.realm;
    const ndc = new THREE.Vector2((this.menuAt.x / innerWidth) * 2 - 1, -(this.menuAt.y / innerHeight) * 2 + 1);
    let cmd: Command;
    if (kind === 'floating_island' && realm.id === 'village') cmd = { op: 'spawn_object', kind, placement: 'above' };
    else {
      const hit = realm.id === 'atom' || realm.id === 'cosmos' || realm.id === 'heavy' ? null : this.engine.rayToPlane(ndc, realm.groundY(0, 0));
      const cam = this.engine.camera.position;
      if (hit && hit.distanceTo(cam) < 30) {
        const y = realm.groundY(hit.x, hit.z) + (kind === 'dragon' || kind === 'orb' || kind === 'crystal' ? 3 : 0);
        cmd = { op: 'spawn_object', kind, position: [+hit.x.toFixed(2), +y.toFixed(2), +hit.z.toFixed(2)] };
      } else cmd = { op: 'spawn_object', kind };
    }
    this.run([cmd], 'gesture');
  }

  drawPortal(ndc: THREE.Vector2, via: 'mouse' | 'hand') {
    this.audio.start();
    const here = this.state.activeRealm;
    const used = new Set(this.state.portals.filter((p) => p.from === here).map((p) => p.to));
    const order = JOURNEY.filter((r) => r !== here);
    const to = order.find((r) => !used.has(r)) ?? order[0];
    const through = this.engine.camera.position.clone().add(this.engine.rig.forward.multiplyScalar(7));
    const p = this.engine.rayToFacingPlane(ndc, through) ?? through;
    const realm = this.engine.realm;
    const y = realm.id === 'atom' || realm.id === 'cosmos' || realm.id === 'heavy' ? p.y : Math.max(realm.groundY(p.x, p.z) + 2.3, p.y);
    this.run([{ op: 'open_portal', to, position: [+p.x.toFixed(2), +y.toFixed(2), +p.z.toFixed(2)] }], 'gesture').then(() => {
      this.hud.system(`${via === 'hand' ? 'Circle drawn by hand' : 'Circle drawn'} → portal to ${REALM_INFO[to].title}. Say “open a portal to …” to choose any destination.`, 'ok');
    });
  }

  push(ndc: THREE.Vector2, strength: number) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.engine.camera);
    const origin = this.engine.camera.position.clone().addScaledVector(ray.ray.direction, 4);
    const hit = this.engine.realm.objects.push(origin, ray.ray.direction.clone().setY(Math.max(0, ray.ray.direction.y)), 10 * strength, 16);
    this.engine.realm.sparks.burst(origin.clone().addScaledVector(ray.ray.direction, 3), '#b388ff', 120, 10);
    this.audio.sfx('push');
    this.hud.tooltip(hit.length ? `Force applied to ${hit.length} object${hit.length > 1 ? 's' : ''}` : 'Force wave — nothing within reach', innerWidth / 2, innerHeight / 2);
    setTimeout(() => this.hud.tooltip(null), 1200);
  }

  hover(p: PickResult, x: number, y: number) {
    let t: string | null = null;
    if (p.portalId) {
      const pt = this.state.portals.find((q) => q.id === p.portalId);
      t = pt ? `Enter portal → ${REALM_INFO[pt.to].title}` : null;
    } else if (p.npcId) t = `Talk to ${NPC_BY_ID[p.npcId].name}`;
    else if (p.gate) t = `Open a portal: ${REALM_INFO[p.gate].title}`;
    else if (p.bodyId) t = `Fly to ${(this.engine.realms.cosmos as Cosmos).sim.ids.includes(p.bodyId) ? this.state.cosmos.bodies.find((b) => b.id === p.bodyId)?.name : p.bodyId}`;
    else if (p.objectId) t = `${this.state.objects.find((o) => o.id === p.objectId)?.name ?? ''} — drag to move · shift+wheel to scale`;
    this.hud.tooltip(t, x, y);
    this.engine.renderer.domElement.style.cursor = t ? 'pointer' : 'grab';
  }

  /** Scroll: powers-of-ten zoom in the atom realm (orbit view); camera zoom/fly elsewhere. */
  wheel(delta: number) {
    if (this.state.activeRealm === 'atom' && this.engine.rig.mode === 'orbit') {
      const prev = this.state.selectedId;
      this.state = { ...this.state, selectedId: undefined };
      this.scaleSelected(Math.exp(-delta * 0.0012));
      this.state = { ...this.state, selectedId: prev };
    } else this.engine.rig.zoom(delta);
  }

  /** Z / X: shrink or grow continuously. Crossing a realm boundary runs the full transition. */
  nudgeScale(f: number) {
    const cur = this.state.observer?.size ?? 1.7;
    const { state } = execute(this.state, { op: 'set_scale', factor: f });
    if (state.activeRealm !== this.state.activeRealm) { this.run([{ op: 'set_scale', factor: f }], 'gesture'); return; }
    this.setState(state);
    if (state.activeRealm !== 'atom') this.engine.realm.applyObserver(state.observer.size, this.engine.rig);
    void cur;
  }

  toggleFly() {
    const rig = this.engine.rig;
    if (rig.mode === 'fly') {
      this.engine.placeCameraOnArrival(this.state.activeRealm,undefined,true);
      this.hud.system('Camera: guided view.', 'ok');
    } else {
      rig.setFly();
      this.hud.system('Free-fly POV: drag to look · WASD to move · E/Q up/down · Shift faster · C to return. You slow down automatically near things.', 'ok');
    }
  }

  hotkey(k: string, down: boolean): boolean {
    if (k === 'v') { down ? this.voice.start() : this.voice.stop(); return true; }
    if (!down) return false;
    const sel = this.state.selectedId;
    switch (k) {
      case 't': case 'enter': this.hud.input.focus(); return true;
      case 'h': case '?': this.hud.toggleHelp(); return true;
      case 'p': this.hud.toggleCinema(); return true;
      case 'g': this.toggleHands(); return true;
      case 'c': this.toggleFly(); return true;
      case 'z': this.nudgeScale(1 / 1.6); return true;
      case 'x': this.nudgeScale(1.6); return true;
      case '`': this.showPerf = !this.showPerf; return true;
      case ' ': this.menuOpen() ? this.hud.closeRadial() : this.openCreateMenu(innerWidth / 2, innerHeight / 2); return true;
      case 'f': this.push(new THREE.Vector2(0, 0), 1.5); return true;
      case 'escape': if (document.body.classList.contains('cinema')) { this.hud.toggleCinema(false); return true; } this.closeMenus(); this.closeDialogue(); if (sel) this.setState({ ...this.state, selectedId: undefined }); return true;
      case 'delete': case 'backspace': if (sel) this.run([{ op: 'delete_object', target: sel }], 'gesture'); return true;
      case 'r': if (sel) this.run([{ op: 'transform_object', target: sel, rotate_by: [0, Math.PI / 4, 0] }], 'gesture'); return true;
      case '[': this.scaleSelected(1 / 1.15); return true;
      case ']': this.scaleSelected(1.15); return true;
    }
    return false;
  }

  async toggleHands(force?: boolean) {
    this.audio.start();
    const on = force ?? !this.hands.running;
    if (!on) {
      this.hands.stop();
      this.hud.handPill.classList.remove('on');
      return;
    }
    this.hud.system('Starting hand tracking (camera stays on this device)…', 'warn');
    try {
      await this.hands.start();
      this.hud.handPill.classList.add('on');
      this.hud.system('Hand tracking on. Pinch to grab · two-hand pinch to scale · point and draw a circle for a portal · hold an open palm to create.', 'ok');
    } catch (e: any) {
      this.hud.system(`Hand tracking unavailable: ${e?.message ?? e}. Mouse & keyboard still work (H for help).`, 'fail');
    }
  }

  // ———————————————————————————————— persistence ————————————————————————————————

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(false), 1500);
  }

  async persist(explicit: boolean): Promise<boolean> {
    this.flushPending();
    const w = { ...this.withCosmosSnapshot(this.state), story: { ...this.state.story, activeConversation: undefined } };
    try {
      if (!this.serverOk && !explicit) throw new Error('offline');
      await api.saveWorld(w);
      this.serverOk = true;
      try {
        const local = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        if (local?.id === w.id && local.updatedAt <= w.updatedAt) localStorage.removeItem(LS_KEY);
      } catch {}
      if (!this.lastSaveOk) this.hud.showBanner(null);
      this.lastSaveOk = true;
      return true;
    } catch {
      this.serverOk = false;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(w));
        this.hud.showBanner('Server unreachable — saving in this browser only.');
        this.lastSaveOk = false;
        return true;
      } catch {
        return false;
      }
    }
  }

  private async toggleWorlds() {
    const m = this.hud.worldsMenu;
    if (m.classList.toggle('open')) {
      m.replaceChildren();
      const hdr = document.createElement('h4');
      hdr.textContent = 'Saved universes';
      hdr.style.cssText = 'margin:2px 4px 8px;font:10px var(--mono);letter-spacing:.14em;color:var(--muted)';
      m.append(hdr);
      let worlds: { id: string; name: string; updatedAt: number; activeRealm: string }[] = [];
      try { worlds = (await api.listWorlds()).worlds; } catch {}
      if (!worlds.some((w) => w.id === this.state.id)) worlds.unshift({ id: this.state.id, name: this.state.name, updatedAt: this.state.updatedAt, activeRealm: this.state.activeRealm });
      for (const w of worlds) {
        const d = document.createElement('div');
        d.className = `w${w.id === this.state.id ? ' cur' : ''}`;
        const n = document.createElement('span');
        n.textContent = w.name;
        const s = document.createElement('small');
        s.textContent = `${w.activeRealm} · ${new Date(w.updatedAt).toLocaleString()}`;
        d.append(n, s);
        d.onclick = async () => {
          m.classList.remove('open');
          if (w.id === this.state.id) return;
          await this.queue;
          if (!await this.persist(true)) { this.hud.system('Could not save this universe. Please try again before switching.', 'fail'); return; }
          try { this.loadWorld((await api.loadWorld(w.id)).world, true); } catch (e: any) { this.hud.system(`Could not load: ${e.message}`, 'fail'); }
        };
        m.append(d);
      }
      const nb = document.createElement('button');
      nb.className = 'new';
      nb.textContent = '+ New universe';
      nb.onclick = async () => {
        const name = prompt('Name your new universe', 'Universe ' + (worlds.length + 1));
        if (!name) return;
        m.classList.remove('open');
        await this.queue;
        if (!await this.persist(true)) { this.hud.system('Could not save this universe. Please try again before creating another.', 'fail'); return; }
        this.loadWorld(createWorld(name.slice(0, 48)));
        this.persist(true);
        this.hud.system(`Created a new universe: “${name}”.`);
      };
      m.append(nb);
    }
  }

  finale() {
    const c = document.createElement('div');
    c.className = 'curtain';
    c.style.opacity = '0';
    c.innerHTML = `<div class="c"><svg viewBox="0 0 160 80"><path d="M20 40c0-16 20-24 40 0s40 16 40 0-20-24-40 0-40 16-40 0" transform="translate(0,0)" fill="none" stroke="#7df9ff" stroke-width="4"/></svg><h1>ANANT</h1><h2>EXPERIENCE THE IMPOSSIBLE.</h2><div class="enter">CLICK TO CONTINUE</div></div>`;
    document.body.append(c);
    requestAnimationFrame(() => (c.style.opacity = '1'));
    this.audio.sfx('warp');
    c.onclick = () => { c.classList.add('gone'); setTimeout(() => c.remove(), 1300); };
  }
}

export { REALMS };
