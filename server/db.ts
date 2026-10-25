/**
 * Persistence: SQLite via Node's built-in `node:sqlite` (no native build step).
 * Worlds are stored as validated JSON snapshots; important events are appended
 * to an event log so a world's history survives restarts.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { REALMS } from '../shared/commands.js';

// Loaded via require so bundlers/test runners don't rewrite the newer `node:sqlite` builtin id.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface WorldRow { id: string; name: string; updatedAt: number; createdAt: number; activeRealm: string }

const MAX_STATE_BYTES = 2_000_000;

export class Store {
  db: DatabaseSyncT;

  constructor(path = 'data/anant.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS worlds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        world_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_world ON events(world_id, t);
    `);
  }

  /** Light structural validation — rejects anything that is not a plausible ANANT world. */
  static validateState(state: any): string | null {
    if (!state || typeof state !== 'object') return 'state must be an object';
    if (state.schema !== 1) return 'unsupported schema version';
    if (typeof state.id !== 'string' || !/^[\w-]{1,64}$/.test(state.id)) return 'invalid id';
    if (typeof state.name !== 'string' || state.name.length > 64) return 'invalid name';
    if (!REALMS.includes(state.activeRealm)) return 'invalid activeRealm';
    if (!Array.isArray(state.objects) || !Array.isArray(state.portals) || !Array.isArray(state.history)) return 'missing arrays';
    if (!state.story || !state.cosmos || !state.atom) return 'missing sub-states';
    return null;
  }

  save(state: any): { ok: true } | { ok: false; error: string } {
    const err = Store.validateState(state);
    if (err) return { ok: false, error: err };
    const json = JSON.stringify(state);
    if (json.length > MAX_STATE_BYTES) return { ok: false, error: 'state too large' };
    this.db
      .prepare(`INSERT INTO worlds (id, name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state, updated_at = excluded.updated_at`)
      .run(state.id, state.name, json, state.createdAt ?? Date.now(), Date.now());
    return { ok: true };
  }

  load(id: string): any | undefined {
    const row = this.db.prepare('SELECT state FROM worlds WHERE id = ?').get(id) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : undefined;
  }

  list(): WorldRow[] {
    const rows = this.db.prepare('SELECT id, name, created_at, updated_at, state FROM worlds ORDER BY updated_at DESC LIMIT 100').all() as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, activeRealm: JSON.parse(r.state).activeRealm }));
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM events WHERE world_id = ?').run(id);
    return this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes > 0;
  }

  logEvent(worldId: string, kind: string, payload: unknown) {
    this.db.prepare('INSERT INTO events (world_id, t, kind, payload) VALUES (?, ?, ?, ?)').run(worldId, Date.now(), kind.slice(0, 40), JSON.stringify(payload).slice(0, 20000));
  }

  events(worldId: string, limit = 100): { t: number; kind: string; payload: any }[] {
    return (this.db.prepare('SELECT t, kind, payload FROM events WHERE world_id = ? ORDER BY id DESC LIMIT ?').all(worldId, limit) as any[]).map((r) => ({ t: r.t, kind: r.kind, payload: JSON.parse(r.payload) }));
  }

  close() {
    this.db.close();
  }
}
