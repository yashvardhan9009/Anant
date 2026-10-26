/**
 * ANANT backend: AI Director + NPC dialogue (Nemotron on Nebius) and persistence.
 * Serves the built client from dist/ in production.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { configFromEnv, NebiusClient } from './nebius.js';
import { direct } from './director.js';
import { npcReply } from './npc.js';
import { Store } from './db.js';
import { NPC_BY_ID } from '../shared/story.js';

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
try {
  const env = await readFile('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT ?? 8787);
const llm = new NebiusClient(configFromEnv());
const store = new Store(process.env.ANANT_DB || 'data/anant.db');
const DIST = join(process.cwd(), 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.task': 'application/octet-stream', '.woff2': 'font/woff2',
};

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 3_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, p);
  if (!file.startsWith(DIST)) return send(res, 403, { error: 'forbidden' });
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found — run `npm run build` first' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const path = url.pathname;
  try {
    if (!path.startsWith('/api/')) return serveStatic(req, res);

    if (path === '/api/health' && req.method === 'GET') {
      let model: string | undefined;
      if (llm.enabled) model = await llm.resolveModel().catch(() => undefined);
      return send(res, 200, {
        ok: true,
        ai: {
          live: llm.enabled && !!model,
          provider: 'Nebius Token Factory',
          model: model ?? null,
          mode: llm.enabled ? (model ? 'nemotron' : 'configured-but-unreachable') : 'offline-parser',
          lastError: llm.lastError ?? null,
          lastLatencyMs: llm.lastLatencyMs ?? null,
        },
      });
    }

    if (path === '/api/director' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.input !== 'string' || !body.world) return send(res, 400, { error: 'expected {input, world}' });
      const reply = await direct(body.input, body.world, llm);
      if (body.world?.id) store.logEvent(body.world.id, 'director', { input: body.input.slice(0, 300), source: reply.source, ops: reply.commands.map((c) => c.op), latencyMs: reply.latencyMs, issues: reply.issues.length });
      return send(res, 200, reply);
    }

    if (path === '/api/npc' && req.method === 'POST') {
      const body = await readBody(req);
      if (!NPC_BY_ID[body.npc] || typeof body.line !== 'string' || !body.story) return send(res, 400, { error: 'expected {npc, line, story}' });
      const reply = await npcReply(body.npc, body.line, body.story, llm);
      if (body.worldId) store.logEvent(body.worldId, 'dialogue', { npc: body.npc, line: body.line.slice(0, 300), speech: reply.outcome.speech, reveals: reply.outcome.reveals, source: reply.source });
      return send(res, 200, reply);
    }

    if (path === '/api/worlds' && req.method === 'GET') return send(res, 200, { worlds: store.list() });
    const m = path.match(/^\/api\/worlds\/([\w-]{1,64})(\/events)?$/);
    if (m) {
      const id = m[1];
      if (m[2]) {
        if (req.method === 'GET') return send(res, 200, { events: store.events(id, Number(url.searchParams.get('limit') || 100)) });
        if (req.method === 'POST') {
          const b = await readBody(req, 50_000);
          store.logEvent(id, String(b.kind || 'event'), b.payload ?? {});
          return send(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET') {
        const w = store.load(id);
        return w ? send(res, 200, { world: w }) : send(res, 404, { error: 'world not found' });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (b.world?.id !== id) return send(res, 400, { error: 'id mismatch' });
        const r = store.save(b.world);
        return r.ok ? send(res, 200, { ok: true, savedAt: Date.now() }) : send(res, 422, { error: r.error });
      }
      if (req.method === 'DELETE') return send(res, store.delete(id) ? 200 : 404, { ok: true });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e: any) {
    console.error('[anant]', e);
    return send(res, e.status ?? 500, { error: e.message ?? 'internal error' });
  }
});

server.listen(PORT, () => {
  const address = server.address();
  console.log(`[anant] server on http://localhost:${typeof address === 'object' && address ? address.port : PORT}`);
  console.log(`[anant] AI: ${llm.enabled ? `Nebius Token Factory @ ${llm.cfg.baseUrl} (model: ${llm.cfg.model ?? 'auto-select Nemotron'})` : 'NO NEBIUS_API_KEY → offline parser / offline dialogue (clearly labelled in the UI)'}`);
});
