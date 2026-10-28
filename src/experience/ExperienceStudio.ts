import { ExperienceRenderer } from "./ExperienceRenderer";
import {
  demoPlan,
  EFFECTS,
  ScenePlanSchema,
  SavedExperienceSchema,
  type EffectKind,
  type ExperienceReply,
  type ExperienceRequest,
} from "../../shared/experience";
import { castElement } from "../../shared/elements";
import { Voice } from "../voice";
import "./experience.css";

const el = <T extends keyof HTMLElementTagNameMap>(
  tag: T,
  cls = "",
  text = "",
) => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
};
export class ExperienceStudio {
  root = el("section", "experience-studio experience-playing");
  private host = el("div", "experience-canvas");
  private renderer: ExperienceRenderer;
  private prompt = el("textarea");
  private status = el("div", "experience-status");
  private title = el("h1");
  private subtitle = el("p");
  private provenance = el("span", "experience-provenance");
  private details = el("aside", "experience-details");
  private detailsBody = el("div");
  private mode = el("select");
  private place = el("input");
  private period = el("input");
  private historyFields = el("div", "experience-history");
  private refine = el("input");
  private submit = el("button", "experience-submit", "Make it happen");
  private cancel = el("button", "", "Cancel");
  private undo = el("button", "", "Undo");
  private redo = el("button", "", "Redo");
  private cameraButton = el("button", "", "Flying · switch to walk");
  private lighting = el("select", "experience-lighting");
  private voice = new Voice();
  private reply: ExperienceReply;
  private undoStack: ExperienceReply[] = [];
  private redoStack: ExperienceReply[] = [];
  private selected: EffectKind | null = null;
  private effectButtons = new Map<EffectKind | null, HTMLButtonElement>();
  private controller?: AbortController;
  private generation = 0;
  private closed = false;
  private busyTimer?: number;
  private audio?: AudioContext;
  private audioGain?: GainNode;
  private noise?: AudioBufferSourceNode;
  private soundButton = el("button", "", "Sound off");
  private drag?: {
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    distance: number;
  };
  private onBlur = () => this.renderer.rig.stopMotion();
  private key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.controller) this.abort();
      else if (this.root.classList.contains("experience-cinema"))
        this.root.classList.remove("experience-cinema");
      else this.onClose();
      return;
    }
    if (e.key === "Tab") {
      const items = [
        ...this.root.querySelectorAll<HTMLElement>(
          "button,input,textarea,select,a,canvas",
        ),
      ].filter((n) => n.offsetParent !== null && !n.hasAttribute("disabled"));
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName))
      return;
    if (
      [
        "w",
        "a",
        "s",
        "d",
        "q",
        "e",
        "shift",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
      ].includes(e.key.toLowerCase())
    ) {
      e.preventDefault();
      this.renderer.rig.keys.add(e.key.toLowerCase());
    }
    if (/^[1-8]$/.test(e.key)) this.select(EFFECTS[Number(e.key) - 1]);
    if (e.key === "0") this.select(null);
    e.stopImmediatePropagation();
  };
  private keyup = (e: KeyboardEvent) =>
    this.renderer.rig.keys.delete(e.key.toLowerCase());

  constructor(
    private onClose: () => void,
    private onSave: (reply: ExperienceReply) => void,
    saved?: ExperienceReply,
    place = "",
  ) {
    this.reply =
      saved && SavedExperienceSchema.safeParse(saved).success
        ? saved
        : {
            plan: demoPlan(),
            source: "template",
            latencyMs: 0,
            sources: [],
            researchStatus: "Authored interactive demonstration.",
            prompt: "",
          };
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Reality studio");
    const header = el("header", "experience-header");
    const back = el("button", "", "← Return");
    back.onclick = onClose;
    const brand = el("div", "experience-brand", "ANANT / REALITY STUDIO");
    const actions = el("div", "experience-actions");
    const evidence = el("button", "", "Scene notes");
    evidence.dataset.sceneNotes='true';
    evidence.setAttribute("aria-expanded", "false");
    evidence.onclick = () => {
      this.details.hidden = !this.details.hidden;
      evidence.setAttribute("aria-expanded", String(!this.details.hidden));
    };
    const cinema = el("button", "", "Cinema");
    cinema.onclick = () => {
      this.root.classList.add("experience-cinema");
      exitCinema.focus();
    };
    const exitCinema = el(
      "button",
      "experience-exit-cinema",
      "Exit cinema · Esc",
    );
    exitCinema.onclick = () => {
      this.root.classList.remove("experience-cinema");
      cinema.focus();
    };
    this.soundButton.onclick = () => void this.toggleSound();
    const create = el("button", "", "Create a world");
    create.onclick = () => {
      this.root.classList.remove("experience-playing");
      this.prompt.focus();
    };
    actions.append(create, this.soundButton, evidence, cinema);
    header.append(back, brand, actions);
    const intro = el("div", "experience-intro");
    intro.append(this.provenance, this.title, this.subtitle);
    this.details.hidden = true;
    this.details.append(el("h2", "", "Behind this scene"), this.detailsBody);
    const dock = el("div", "experience-dock");
    const toolbar = el("div", "experience-toolbar");
    for (const [key, name] of [
      [null, "Explore"],
      ...EFFECTS.map((k) => [k, k[0].toUpperCase() + k.slice(1)]),
    ] as [EffectKind | null, string][]) {
      const b = el("button", "", name);
      b.onclick = () => this.select(key);
      b.setAttribute("aria-pressed", String(key === null));
      this.effectButtons.set(key, b);
      toolbar.append(b);
    }
    const controls = el("div", "experience-controls");
    this.undo.onclick = () => this.restore(false);
    this.redo.onclick = () => this.restore(true);
    const freeze = el("button", "", "Pause time");
    freeze.setAttribute("aria-pressed", "false");
    freeze.onclick = () => {
      this.renderer.frozen = !this.renderer.frozen;
      freeze.textContent = this.renderer.frozen ? "Resume time" : "Pause time";
      freeze.setAttribute("aria-pressed", String(this.renderer.frozen));
    };
    const camera = this.cameraButton;
    camera.onclick = () => {
      if (this.renderer.rig.mode === "walk") {
        this.renderer.rig.setFly();
        camera.textContent = "Flying · switch to walk";
      } else {
        this.renderer.rig.setWalk(
          this.renderer.camera.position.clone(),
          this.renderer.rig.yaw,
          this.renderer.rig.pitch,
        );
        camera.textContent = "Walking · switch to fly";
      }
    };
    controls.append(this.undo, this.redo, freeze, camera);
    this.lighting.setAttribute("aria-label", "Scene lighting");
    for (const [value, label] of [
      ["day", "Daylight"],
      ["golden", "Golden hour"],
      ["blue", "Blue hour"],
      ["night", "Night"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      this.lighting.append(option);
    }
    this.lighting.onchange = () => {
      this.abort(false);
      this.remember();
      const time = this.lighting
        .value as ExperienceReply["plan"]["environment"]["time"];
      const sky = {
        day: "#5e9fcb",
        golden: "#8ea8bc",
        blue: "#101e34",
        night: "#070e22",
      }[time];
      this.reply = {
        ...this.reply,
        plan: {
          ...this.reply.plan,
          environment: { ...this.reply.plan.environment, time, sky },
        },
      };
      void this.present();
      this.onSave(this.reply);
      this.status.textContent =
        "Lighting updated. Your scene layout is preserved.";
    };
    controls.append(this.lighting);
    const modes = el("div", "experience-modes");
    this.mode.setAttribute("aria-label", "Creation mode");
    for (const [value, name] of [
      ["imagine", "Imagine anything"],
      ["history", "Reconstruct the past"],
    ]) {
      const option = el("option", "", name);
      option.value = value;
      this.mode.append(option);
    }
    this.mode.onchange = () => {
      this.historyFields.hidden = this.mode.value !== "history";
    };
    this.place.placeholder = "Place, e.g. Rome";
    this.place.setAttribute("aria-label", "Historical place");
    this.place.value = place;
    this.place.maxLength = 120;
    this.period.placeholder = "Period, e.g. 100 CE";
    this.period.setAttribute("aria-label", "Historical period");
    this.period.maxLength = 100;
    this.historyFields.append(this.place, this.period);
    this.historyFields.hidden = true;
    if (
      this.reply.context?.mode === "history" ||
      this.reply.plan.reconstruction
    ) {
      this.mode.value = "history";
      this.place.value = this.reply.context?.place ?? place;
      this.period.value =
        this.reply.context?.period ??
        this.reply.plan.reconstruction?.period ??
        "";
      this.historyFields.hidden = false;
    }
    const refineLabel = el("label", "", "Refine this scene");
    this.refine.type = "checkbox";
    this.refine.checked = false;
    refineLabel.prepend(this.refine);
    modes.append(this.mode, refineLabel);
    const form = el("form", "experience-form");
    this.prompt.rows = 2;
    this.prompt.maxLength = 1600;
    this.prompt.placeholder =
      "Describe a place, a phenomenon, an impossible world…";
    this.prompt.setAttribute("aria-label", "Describe your reality");
    this.prompt.onfocus = () =>
      this.root.classList.remove("experience-playing");
    this.prompt.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.generate();
      }
    };
    const mic = el("button", "", "Speak");
    mic.type = "button";
    mic.disabled = !this.voice.supported;
    mic.title = this.voice.supported
      ? "Speak a wish; review it before creating. Your browser provides speech recognition."
      : "Speech recognition is unavailable in this browser. Type a wish instead.";
    mic.onclick = () => {
      if (this.voice.listening) this.voice.stop();
      else this.voice.start();
    };
    this.voice.onState = (listening) => {
      mic.textContent = listening ? "Listening…" : "Speak";
      mic.setAttribute("aria-pressed", String(listening));
    };
    this.voice.onResult = (text) => (this.prompt.value = text);
    this.submit.type = "submit";
    this.cancel.type = "button";
    this.cancel.hidden = true;
    this.cancel.onclick = () => this.abort();
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.generate();
    };
    form.append(this.prompt, mic, this.submit, this.cancel);
    const suggestions = el("div", "experience-suggestions");
    for (const [label, prompt] of [
      [
        "Fire & water",
        "Create a fire and water sanctuary with stone arches at blue hour",
      ],
      [
        "Impossible garden",
        "Imagine a floating crystal garden with reflective water and an aurora at night",
      ],
      ["Ancient Rome", "Reconstruct a street in ancient Rome around 100 CE"],
    ]) {
      const b = el("button", "", label);
      b.onclick = () => {
        this.refine.checked = false;
        this.prompt.value = prompt;
        if (label === "Ancient Rome") {
          this.mode.value = "history";
          this.place.value = "Rome";
          this.period.value = "100 CE";
          this.historyFields.hidden = false;
        } else {
          this.mode.value = "imagine";
          this.historyFields.hidden = true;
        }
        void this.generate();
      };
      suggestions.append(b);
    }
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    dock.append(
      toolbar,
      controls,
      modes,
      this.historyFields,
      form,
      suggestions,
      this.status,
    );
    const guide = el(
      "div",
      "experience-guide",
      "Drag to look · WASD to fly · E/Q rise / descend · 1–8 select an element · Click to cast · 0 explore",
    );
    const reticle = el("div", "experience-reticle", "+");
    reticle.setAttribute("aria-hidden", "true");
    this.root.append(
      this.host,
      header,
      intro,
      this.details,
      dock,
      guide,
      reticle,
      exitCinema,
    );
    document.body.append(this.root);
    this.renderer = new ExperienceRenderer(this.host);
    const canvas = this.renderer.renderer.domElement;
    this.root.addEventListener("focusin", (event) => {
      if (event.target !== canvas) this.renderer.rig.stopMotion();
    });
    canvas.onpointerdown = (e) => {
      this.root.classList.add("experience-playing");
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        distance: 0,
      };
    };
    canvas.onpointermove = (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.lastX,
        dy = e.clientY - this.drag.lastY;
      this.drag.distance += Math.abs(dx) + Math.abs(dy);
      this.renderer.rig.rotate(dx, dy);
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
    };
    canvas.onpointerup = (e) => {
      const click = this.drag && this.drag.distance < 6;
      this.drag = undefined;
      if (click && this.selected)
        this.cast(this.selected, this.renderer.hit(e.clientX, e.clientY));
    };
    canvas.onpointercancel = () => (this.drag = undefined);
    canvas.onwheel = (e) => {
      e.preventDefault();
      this.renderer.rig.zoom(e.deltaY);
    };
    window.addEventListener("keydown", this.key, true);
    window.addEventListener("keyup", this.keyup, true);
    window.addEventListener("blur", this.onBlur);
    void this.present(true);
    back.focus();
  }
  setPrompt(text: string) {
    this.root.classList.remove("experience-playing");
    this.prompt.value = text;
    if (
      /past|ancient|prehistor|reconstruct|\d+\s*(bc|ce|ad|years ago)/i.test(
        text,
      )
    ) {
      this.mode.value = "history";
      this.historyFields.hidden = false;
    }
    this.prompt.focus();
  }
  private select(kind: EffectKind | null) {
    this.selected = kind;
    this.root.dataset.element = kind ?? "explore";
    for (const [k, b] of this.effectButtons)
      b.setAttribute("aria-pressed", String(k === kind));
    this.status.textContent = kind
      ? `${kind[0].toUpperCase() + kind.slice(1)} ready. Click in the world to cast.`
      : "Explore freely. Drag to look, WASD to fly, E/Q to rise or descend.";
  }
  private cast(kind: EffectKind, point: [number, number, number]) {
    this.abort(false);
    const result = castElement(this.reply.plan, kind, point);
    this.remember();
    this.reply = { ...this.reply, plan: result.plan };
    void this.present().then(() => {
      if (!this.closed) this.renderer.launch(kind, point);
    });
    this.status.textContent = result.message;
    this.onSave(this.reply);
  }
  async generate() {
    const prompt = this.prompt.value.trim();
    if (!prompt) return;
    const spell = prompt.match(
      /^(?:cast|summon|use) (?:a )?(fire|water|ice|lightning|vortex|portal|steam)(?: spell|ball)?[.!]?$/i,
    );
    if (spell) {
      const rect = this.host.getBoundingClientRect();
      this.cast(
        spell[1].toLowerCase() as EffectKind,
        this.renderer.hit(
          rect.left + rect.width / 2,
          rect.top + rect.height * 0.62,
        ),
      );
      return;
    }
    this.abort(false);
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.submit.disabled = true;
    this.cancel.hidden = false;
    const start = Date.now();
    const update = () => {
      this.status.textContent = `${this.mode.value === "history" ? "Researching public references and composing" : "Composing your world"} · ${Math.floor((Date.now() - start) / 1000)}s. You can keep exploring.`;
    };
    update();
    this.busyTimer = window.setInterval(update, 1000);
    const request: ExperienceRequest = {
      prompt,
      mode: this.mode.value as "history" | "imagine",
      place: this.place.value,
      period: this.period.value,
      ...(this.refine.checked ? { current: this.reply.plan } : {}),
    };
    try {
      const response = await fetch("/api/experience", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: this.controller.signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "The scene request failed");
      if (this.closed || generation !== this.generation) return;
      const plan = ScenePlanSchema.parse(data.plan);
      if (data.source !== "ai") {
        this.status.textContent =
          data.fallbackReason ??
          "AI unavailable. Your current scene is preserved.";
        return;
      }
      this.remember();
      this.reply = { ...data, plan };
      if (data.context) {
        this.mode.value = data.context.mode;
        this.place.value = data.context.place;
        this.period.value = data.context.period;
        this.historyFields.hidden = data.context.mode !== "history";
      }
      await this.present(!this.refine.checked);
      if (this.closed || generation !== this.generation) return;
      this.onSave(this.reply);
      this.refine.checked = true;
      this.status.textContent = `Created by ${data.model} in ${(data.latencyMs / 1000).toFixed(1)}s. Saved with this world.`;
      if(data.limitations?.length)this.status.textContent+=` ${data.limitations.length} requested behaviours unavailable; see scene notes.`;
    } catch (error) {
      if (!this.closed && generation === this.generation)
        this.status.textContent =
          error instanceof Error
            ? error.message
            : "Could not create this scene. Try again.";
    } finally {
      if (generation === this.generation) {
        clearInterval(this.busyTimer);
        this.controller = undefined;
        this.submit.disabled = false;
        this.cancel.hidden = true;
      }
    }
  }
  private abort(show = true) {
    ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    clearInterval(this.busyTimer);
    this.submit.disabled = false;
    this.cancel.hidden = true;
    if (show)
      this.status.textContent = "Creation cancelled. Your scene is unchanged.";
  }
  private remember() {
    this.undoStack.push(structuredClone(this.reply));
    if (this.undoStack.length > 12) this.undoStack.shift();
    this.redoStack = [];
  }
  private restore(redo: boolean) {
    const from = redo ? this.redoStack : this.undoStack,
      to = redo ? this.undoStack : this.redoStack;
    const reply = from.pop();
    if (!reply) return;
    this.abort(false);
    to.push(structuredClone(this.reply));
    this.reply = reply;
    this.mode.value =
      reply.context?.mode ??
      (reply.plan.reconstruction ? "history" : "imagine");
    this.place.value = reply.context?.place ?? "";
    this.period.value =
      reply.context?.period ?? reply.plan.reconstruction?.period ?? "";
    this.historyFields.hidden = this.mode.value !== "history";
    void this.present();
    this.onSave(reply);
    this.status.textContent = redo ? "Change restored." : "Change undone.";
  }
  private async present(reset = false) {
    this.lighting.value = this.reply.plan.environment.time;
    this.title.textContent = this.reply.plan.title;
    this.subtitle.textContent = this.reply.plan.description;
    this.provenance.textContent = this.reply.plan.reconstruction
      ? "ARTISTIC RECONSTRUCTION"
      : this.reply.source === "ai"
        ? "AI-COMPOSED EXPERIENCE"
        : "INTERACTIVE DEMONSTRATION";
    this.root.dataset.source = this.reply.source;
    this.root.dataset.effectCount = String(this.reply.plan.effects.length);
    this.undo.disabled = !this.undoStack.length;
    this.redo.disabled = !this.redoStack.length;
    this.detailsBody.replaceChildren(
      el(
        "p",
        "",
        this.reply.source === "ai"
          ? `Composed by ${this.reply.model}. Real-time scene kit with scanned materials.`
          : "Authored scene. No AI generation claimed.",
      ),
    );
    this.detailsBody.append(
      el(
        "p",
        "",
        "Visual effects approximate phenomena; they are not full physical simulations. Geometry is assembled from a bounded set of shapes and assets.",
      ),
    );
    if(this.reply.limitations?.length) {
      this.details.hidden=false;
      this.root.querySelector('[data-scene-notes]')?.setAttribute('aria-expanded','true');
      this.detailsBody.append(el('h3','','Requested behaviours unavailable'));
      const list=el('ul','experience-limitations');
      for(const limitation of this.reply.limitations)list.append(el('li','',limitation));
      this.detailsBody.append(list);
    }
    if (this.reply.plan.reconstruction) {
      this.detailsBody.append(
        el("h3", "", this.reply.plan.reconstruction.period),
        el("p", "", this.reply.plan.reconstruction.interpretation),
        el(
          "p",
          "",
          "Every placement, architectural dimension, color, and lighting choice is an artistic approximation, not a verified record of the past.",
        ),
      );
    }
    this.detailsBody.append(el("p", "", this.reply.researchStatus));
    for (const source of this.reply.sources ?? []) {
      if (!source.url.startsWith("https://en.wikipedia.org/wiki/")) continue;
      const a = el("a", "", source.title);
      a.href = source.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      this.detailsBody.append(a, el("p", "experience-extract", source.extract));
    }
    if (this.reply.sources?.length)
      this.detailsBody.append(
        el(
          "small",
          "",
          "Reference excerpts: Wikipedia contributors · CC BY-SA. Check the linked articles and their references for historical evidence.",
        ),
      );
    await this.renderer.setPlan(this.reply.plan, reset);
    this.cameraButton.textContent =
      this.renderer.rig.mode === "fly"
        ? "Flying · switch to walk"
        : "Walking · switch to fly";
  }
  private async toggleSound() {
    if (this.audio) {
      if (this.audio.state === "running") {
        await this.audio.suspend();
        this.soundButton.textContent = "Sound off";
      } else {
        await this.audio.resume();
        this.soundButton.textContent = "Sound on";
      }
      return;
    }
    try {
      this.audio = new AudioContext();
      this.audioGain = this.audio.createGain();
      this.audioGain.gain.value = 0.08;
      this.audioGain.connect(this.audio.destination);
      const buffer = this.audio.createBuffer(
          1,
          this.audio.sampleRate * 3,
          this.audio.sampleRate,
        ),
        data = buffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < data.length; i++) {
        brown = (brown + (Math.random() * 2 - 1) * 0.025) / 1.02;
        data[i] = brown * 3;
      }
      this.noise = this.audio.createBufferSource();
      this.noise.buffer = buffer;
      this.noise.loop = true;
      const filter = this.audio.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 900;
      this.noise.connect(filter);
      filter.connect(this.audioGain);
      this.noise.start();
      await this.audio.resume();
      this.soundButton.textContent = "Sound on";
      this.renderer.onFrame = (position) => {
        const nearest = Math.min(
          50,
          ...this.reply.plan.effects
            .filter(
              (e) =>
                e.kind === "fire" || e.kind === "water" || e.kind === "vortex",
            )
            .map((e) =>
              Math.hypot(
                position.x - e.position[0],
                position.z - e.position[2],
              ),
            ),
        );
        this.audioGain!.gain.setTargetAtTime(
          this.renderer.frozen ? 0 : 0.025 + 0.18 / (1 + nearest * 0.3),
          this.audio!.currentTime,
          0.2,
        );
      };
    } catch {
      this.soundButton.textContent = "Sound unavailable";
    }
  }
  dispose() {
    this.closed = true;
    this.abort(false);
    this.voice.onResult = undefined;
    this.voice.onState = undefined;
    this.voice.stop();
    window.removeEventListener("keydown", this.key, true);
    window.removeEventListener("keyup", this.keyup, true);
    window.removeEventListener("blur", this.onBlur);
    this.noise?.stop();
    void this.audio?.close();
    this.renderer.dispose();
    this.root.remove();
  }
}
