/**
 * Nebius Token Factory client (OpenAI-compatible chat completions).
 * Credentials are read from the server environment only and never sent to the browser.
 */

export interface LlmConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
}

export type LlmErrorKind = 'no-credentials' | 'timeout' | 'http' | 'network' | 'parse' | 'no-model';
export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, message: string, public status?: number) {
    super(message);
  }
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** NVIDIA open models, in order of preference for structured instruction following. */
export const PREFERRED_MODELS = [
  'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5',
  'nvidia/NVIDIA-Nemotron-Nano-9B-v2',
  'nvidia/Nemotron-Nano-V2-12b',
  'nvidia/Llama-3_1-Nemotron-Ultra-253B-v1',
];

export function configFromEnv(env = process.env): LlmConfig {
  return {
    apiKey: env.ANANT_OFFLINE === '1' ? undefined : env.NEBIUS_API_KEY || undefined,
    baseUrl: (env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
    model: env.ANANT_MODEL || undefined,
    timeoutMs: Number(env.ANANT_LLM_TIMEOUT_MS || 15000),
  };
}

export class NebiusClient {
  private resolvedModel?: string;
  lastError?: string;
  lastLatencyMs?: number;

  constructor(public cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {}

  get enabled() {
    return !!this.cfg.apiKey;
  }

  get model() {
    return this.resolvedModel ?? this.cfg.model;
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.cfg.timeoutMs): Promise<any> {
    if (!this.cfg.apiKey) throw new LlmError('no-credentials', 'NEBIUS_API_KEY is not set');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
      });
      const text = await res.text();
      if (!res.ok) throw new LlmError('http', `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError('parse', 'response was not JSON');
      }
    } catch (e: any) {
      if (e instanceof LlmError) throw e;
      if (e?.name === 'AbortError') throw new LlmError('timeout', `timed out after ${timeoutMs} ms`);
      throw new LlmError('network', e?.message ?? String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pick a model: explicit config wins; otherwise the best available NVIDIA Nemotron model. */
  async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    if (this.cfg.model) return (this.resolvedModel = this.cfg.model);
    const list = await this.request('/models', { method: 'GET' }, Math.min(this.cfg.timeoutMs, 8000));
    const ids: string[] = (list?.data ?? []).map((m: any) => m.id).filter(Boolean);
    const pick = PREFERRED_MODELS.find((p) => ids.includes(p)) ?? ids.find((id) => /nemotron/i.test(id)) ?? ids.find((id) => /^nvidia\//i.test(id));
    if (!pick) throw new LlmError('no-model', `no NVIDIA model found among ${ids.length} available models`);
    return (this.resolvedModel = pick);
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<{ text: string; model: string; latencyMs: number }> {
    const model = await this.resolveModel();
    const t0 = Date.now();
    // Nemotron reasoning models: "/no_think" disables the long reasoning trace for snappy, structured replies.
    const msgs = /nemotron/i.test(model) && messages[0]?.role === 'system' ? [{ ...messages[0], content: `/no_think\n${messages[0].content}` }, ...messages.slice(1)] : messages;
    try {
      const json = await this.request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model, messages: msgs, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.4 }),
      });
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new LlmError('parse', 'no message content in completion');
      this.lastLatencyMs = Date.now() - t0;
      this.lastError = undefined;
      return { text, model, latencyMs: this.lastLatencyMs };
    } catch (e: any) {
      this.lastError = `${e.kind ?? 'error'}: ${e.message}`;
      throw e;
    }
  }
}

/** Pull the first JSON object out of a model reply (handles <think> blocks and ``` fences). */
export function extractJSON(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start < 0) throw new LlmError('parse', 'no JSON object in reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch (e: any) {
          throw new LlmError('parse', `invalid JSON: ${e.message}`);
        }
      }
    }
  }
  throw new LlmError('parse', 'unterminated JSON object');
}
