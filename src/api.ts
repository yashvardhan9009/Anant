import type { DirectorReply } from '../shared/commands';
import type { WorldState } from '../shared/worldState';
import type { DialogueOutcome, StoryState } from '../shared/story';

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Health { ok: boolean; ai: { live: boolean; provider: string; model: string | null; mode: string; lastError: string | null; lastLatencyMs: number | null } }
export interface NpcApiReply { outcome: DialogueOutcome; source: 'nemotron' | 'local-ai' | 'offline-dialogue'; model?: string; latencyMs: number; fallbackReason?: string; droppedReveals: string[] }

export const api = {
  health: () => fetch('/api/health').then((r) => j<Health>(r)),
  director: (input: string, world: WorldState) =>
    fetch('/api/director', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, world }) }).then((r) => j<DirectorReply>(r)),
  npc: (npc: string, line: string, story: StoryState, worldId: string) =>
    fetch('/api/npc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ npc, line, story, worldId }) }).then((r) => j<NpcApiReply>(r)),
  listWorlds: () => fetch('/api/worlds').then((r) => j<{ worlds: { id: string; name: string; updatedAt: number; activeRealm: string }[] }>(r)),
  loadWorld: (id: string) => fetch(`/api/worlds/${id}`).then((r) => j<{ world: WorldState }>(r)),
  saveWorld: (w: WorldState) => fetch(`/api/worlds/${w.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world: w }) }).then((r) => j<{ ok: true; savedAt: number }>(r)),
  deleteWorld: (id: string) => fetch(`/api/worlds/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
};
