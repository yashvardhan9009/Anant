import { describe, it, expect, vi } from 'vitest';
import { App } from '../src/App';
import { Cosmos } from '../src/realms/Cosmos';
import { createWorld, execute } from '../shared/worldState';
import { NBody } from '../shared/physics';
import { parseIntent } from '../shared/localParser';
import { Vector3 } from 'three';

// Run production state methods with only graphics, sound and DOM side effects stubbed.
function appHarness() {
  const noop = () => {};
  const realm = { resetForWorld: vi.fn(), ensureBuilt: noop, scene: {}, onEnter: noop };
  const app: any = Object.create(App.prototype);
  Object.assign(app, {
    pending: {}, undoStack: [], redoStack: [], worldGeneration: 0,
    engine: { realms: { cosmos: { ...realm, built: false } }, realm, renderPass: {}, sync: noop, placeCameraOnArrival: noop },
    hud: { closeDialogue: noop, setObserver: noop }, audio: { ambience: noop, sfx: noop },
    refreshCard: noop, applyObserverFor: noop, scheduleSave: noop, ctx: () => ({}),
  });
  return app;
}

describe('saved world isolation', () => {
  it('cannot undo or redo changes from a different saved world', async () => {
    const app = appHarness();
    const a = createWorld('A'), b = createWorld('B');
    app.loadWorld(a);
    await app.exec({ op: 'spawn_object', kind: 'crystal' });
    await app.exec({ op: 'undo' });
    expect(app.redoStack).toHaveLength(1);
    app.loadWorld(b);
    expect((await app.exec({ op: 'redo' })).ok).toBe(false);
    expect((await app.exec({ op: 'undo' })).ok).toBe(false);
    expect(app.state.id).toBe(b.id);
    expect(app.state.objects).toHaveLength(0);
  });

  it('cancels pending edits and releases held bodies when loading', () => {
    vi.useFakeTimers();
    try {
      const app = appHarness();
      const pending = vi.fn();
      app.pending = { timer: setTimeout(pending, 350), scale: 4 };
      app.saveTimer = setTimeout(pending, 1500);
      app.bodyGrab = { id: 'sun' };
      const w = createWorld();
      w.cosmos.grabbed = 'sun';
      app.loadWorld(w);
      vi.runAllTimers();
      expect(pending).not.toHaveBeenCalled();
      expect(app.bodyGrab).toBeUndefined();
      expect(app.state.cosmos.grabbed).toBeUndefined();
      expect(w.cosmos.grabbed).toBe('sun');
      expect(app.engine.realms.cosmos.resetForWorld).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('creates distinct worlds within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    try { expect(createWorld().id).not.toBe(createWorld().id); }
    finally { vi.restoreAllMocks(); }
  });

  it('reloads orbital positions across worlds with equal revision counters', () => {
    const a = createWorld('A'), b = createWorld('B');
    const saved = new NBody(b.cosmos.bodies);
    saved.advance(0.2);
    b.cosmos.bodies = saved.snapshot(b.cosmos.bodies);
    const cos: any = Object.create(Cosmos.prototype);
    Object.assign(cos, {
      id: 'cosmos', worldId: a.id, epoch: a.cosmos.epoch, revision: 0,
      sim: new NBody(a.cosmos.bodies), objects: { sync() {} },
      ensureBuilt() {}, applyEnv() {},
      // GPU meshes aren't relevant to the production rebuild decision.
      rebuild(defs: any) { this.sim.load(defs); },
    });
    cos.sync(b, 0);
    expect(cos.sim.getPos(cos.sim.index('earth'))).toEqual(b.cosmos.bodies.find(d => d.id === 'earth')!.pos);
    // Explicitly reloading the same world must also restore its saved positions.
    cos.sim.advance(0.1);
    cos.resetForWorld();
    cos.sync(b, 0);
    expect(cos.sim.getPos(cos.sim.index('earth'))).toEqual(b.cosmos.bodies.find(d => d.id === 'earth')!.pos);
  });
});

describe('time controls', () => {
  it('unfreezes global time', () => {
    let w = execute(createWorld(), { op: 'set_time', frozen: true }).state;
    for (const command of parseIntent('unfreeze time', w).commands) w = execute(w, command).state;
    expect(w.time.frozen).toBe(false);
  });
  it.each(['cosmos', 'heavy'] as const)('unpauses the %s simulation', realm => {
    let w = execute(createWorld(), { op: 'go_to_realm', realm }).state;
    w = execute(w, { op: 'cosmos_set_sim', paused: true }).state;
    for (const phrase of ['unpause the simulation', 'resume', 'play']) {
      const reply = parseIntent(phrase, w);
      for (const command of reply.commands) w = execute(w, command).state;
      expect(w.cosmos.paused).toBe(false);
    }
    for (const command of parseIntent('pause the simulation', w).commands) w = execute(w, command).state;
    expect(w.cosmos.paused).toBe(true);
  });
});

describe('direct manipulation history', () => {
  it('undoes a drag without deleting the object', async () => {
    const app = appHarness();
    app.loadWorld(createWorld());
    await app.exec({ op: 'spawn_object', kind: 'crystal' });
    const object = app.state.objects[0];
    const view = { holder: { position: new Vector3(...object.position) }, moving: false };
    app.engine.realm.objects = { get: () => view };
    app.beginGrab(object.id, view.holder.position.clone());
    view.holder.position.x += 3;
    app.endGrab();
    expect(app.state.objects[0].position[0]).toBe(object.position[0] + 3);
    await app.exec({ op: 'undo' });
    expect(app.state.objects).toHaveLength(1);
    expect(app.state.objects[0].position).toEqual(object.position);
    await app.exec({ op: 'redo' });
    expect(app.state.objects[0].position[0]).toBe(object.position[0] + 3);
  });

  it('flushes a pending scale before undo, and cancels its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    try {
      const app = appHarness();
      app.loadWorld(createWorld());
      await app.exec({ op: 'spawn_object', kind: 'crystal' });
      const object = app.state.objects[0];
      app.state.selectedId = object.id;
      app.engine.realm.objects = { get: () => ({ obj: object }) };
      app.scaleSelected(2);
      await app.exec({ op: 'undo' });
      vi.runAllTimers();
      expect(app.state.objects).toHaveLength(1);
      expect(app.state.objects[0].scale).toBe(object.scale);
      await app.exec({ op: 'redo' });
      expect(app.state.objects[0].scale).toBe(object.scale * 2);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
