import { describe, it, expect, vi } from 'vitest';
import { direct } from '../server/director';
import { NebiusClient, extractJSON } from '../server/nebius';
import { createWorld } from '../shared/worldState';

const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const models = () => new Response(JSON.stringify({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }, { id: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5' }] }), { status: 200 });

function client(handler: (url: string, init: any) => Promise<Response> | Response, timeoutMs = 2000) {
  return new NebiusClient({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', timeoutMs }, ((url: string, init: any) => Promise.resolve(handler(url, init))) as any);
}

describe('extractJSON', () => {
  it('handles think blocks, fences and trailing prose', () => {
    expect(extractJSON('<think>hmm {not json}</think>```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJSON('Sure! {"a":{"b":"}"}} hope that helps')).toEqual({ a: { b: '}' } });
    expect(() => extractJSON('no json here')).toThrow();
  });
});

describe('AI Director', () => {
  it('without credentials uses the labelled offline parser', async () => {
    const r = await direct('take me inside an atom', createWorld(), new NebiusClient({ baseUrl: 'x', timeoutMs: 100 }));
    expect(r.source).toBe('local-parser');
    expect(r.fallbackReason).toMatch(/NEBIUS_API_KEY/);
    expect(r.commands).toEqual([{ op: 'go_to_realm', realm: 'atom' }]);
  });

  it('auto-selects a Nemotron model, sends /no_think, keeps the key in the header only', async () => {
    const calls: any[] = [];
    const llm = client((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/models')) return models();
      return completion('{"narration":"Into the atom.","commands":[{"op":"go_to_realm","realm":"atom"},{"op":"atom_set_orbital","n":2,"l":1,"m":0}],"unsupported":[]}');
    });
    const r = await direct('atom please, 2p', createWorld(), llm);
    expect(r.source).toBe('nemotron');
    expect(r.model).toBe('nvidia/Llama-3_3-Nemotron-Super-49B-v1_5');
    expect(r.commands).toHaveLength(2);
    const body = JSON.parse(calls[1].init.body);
    expect(body.model).toBe('nvidia/Llama-3_3-Nemotron-Super-49B-v1_5');
    expect(body.messages[0].content.startsWith('/no_think')).toBe(true);
    expect(calls[1].init.headers.Authorization).toBe('Bearer test-key');
    expect(calls[1].init.body).not.toContain('test-key');
  });

  it('drops invalid commands from the model and reports them', async () => {
    const llm = client((url) => url.endsWith('/models') ? models() : completion('{"narration":"","commands":[{"op":"delete_universe"},{"op":"atom_set_orbital","n":1,"l":2,"m":0},{"op":"set_time","frozen":true}]}'));
    const r = await direct('do stuff', createWorld(), llm);
    expect(r.source).toBe('nemotron');
    expect(r.commands).toEqual([{ op: 'set_time', frozen: true }]);
    expect(r.issues).toHaveLength(2);
  });

  it('repairs malformed output once, then succeeds', async () => {
    let n = 0;
    const llm = client((url) => {
      if (url.endsWith('/models')) return models();
      n++;
      return n === 1 ? completion('I think you want to freeze time.') : completion('{"narration":"Time halts.","commands":[{"op":"set_time","frozen":true}]}');
    });
    const r = await direct('freeze time', createWorld(), llm);
    expect(n).toBe(2);
    expect(r.source).toBe('nemotron');
    expect(r.commands).toEqual([{ op: 'set_time', frozen: true }]);
  });

  it('falls back on HTTP errors', async () => {
    const llm = client((url) => url.endsWith('/models') ? models() : new Response('overloaded', { status: 503 }));
    const r = await direct('freeze time', createWorld(), llm);
    expect(r.source).toBe('local-parser');
    expect(r.fallbackReason).toMatch(/http/);
    expect(r.commands).toEqual([{ op: 'set_time', frozen: true }]);
  });

  it('falls back on timeout', async () => {
    const llm = client((url, init) => url.endsWith('/models') ? models() : new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 150);
    const t0 = Date.now();
    const r = await direct('freeze time', createWorld(), llm);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.source).toBe('local-parser');
    expect(r.fallbackReason).toMatch(/timeout/);
  });

  it('falls back when no NVIDIA model exists on the account', async () => {
    const llm = client((url) => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'meta-llama/x' }] })) : completion('{}'));
    const r = await direct('freeze time', createWorld(), llm);
    expect(r.source).toBe('local-parser');
    expect(r.fallbackReason).toMatch(/no-model/);
  });
});
