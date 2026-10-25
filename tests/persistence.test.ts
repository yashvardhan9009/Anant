import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db';
import { createWorld, execute } from '../shared/worldState';

describe('SQLite persistence', () => {
  it('saves, lists, reloads multiple worlds across reopen, and logs events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anant-'));
    const path = join(dir, 'test.db');
    let store = new Store(path);
    let a = createWorld('Alpha', 'alpha');
    a = execute(a, { op: 'go_to_realm', realm: 'village' }).state;
    a = execute(a, { op: 'spawn_object', kind: 'castle', scale: 2 }).state;
    const b = createWorld('Beta', 'beta');
    expect(store.save(a)).toEqual({ ok: true });
    expect(store.save(b)).toEqual({ ok: true });
    store.logEvent('alpha', 'director', { input: 'make a castle' });
    store.close();

    store = new Store(path);
    expect(store.list().map((w) => w.id).sort()).toEqual(['alpha', 'beta']);
    const back = store.load('alpha');
    expect(back.objects[0].kind).toBe('castle');
    expect(back.activeRealm).toBe('village');
    expect(back).toEqual(a);
    expect(store.events('alpha')[0].payload.input).toBe('make a castle');
    // update in place
    a = execute(a, { op: 'transform_object', target: 'castle', scale_by: 2 }).state;
    store.save(a);
    expect(store.load('alpha').objects[0].scale).toBe(4);
    expect(store.delete('beta')).toBe(true);
    expect(store.list()).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects malformed states', () => {
    const store = new Store(':memory:');
    expect(store.save({ hello: 'world' }).ok).toBe(false);
    expect(store.save({ ...createWorld(), activeRealm: 'hell' }).ok).toBe(false);
    expect(store.save({ ...createWorld(), id: '../../etc' }).ok).toBe(false);
  });
});
