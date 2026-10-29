/**
 * Nebius Token Factory client (OpenAI-compatible chat completions).
 * Credentials are read from the server environment only and never sent to the browser.
 */

export interface LlmConfig {
  provider?: 'nebius' | 'ollama';
  apiKey?: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  keepAlive?: string | number;
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
  const local = env.ANANT_OFFLINE !== '1' && env.ANANT_AI_PROVIDER === 'ollama';
  return {
    provider: local ? 'ollama' : 'nebius',
    apiKey: env.ANANT_OFFLINE === '1' || local ? undefined : env.NEBIUS_API_KEY || undefined,
    baseUrl: (local ? env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434' : env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, ''),
    model: (local ? env.OLLAMA_MODEL : env.ANANT_MODEL) || undefined,
    timeoutMs: Number(env.ANANT_LLM_TIMEOUT_MS || (local ? 120000 : 15000)),
    keepAlive: env.OLLAMA_KEEP_ALIVE || 0,
  };
}

export class NebiusClient {
  private resolvedModel?: string;
  lastError?: string;
  lastLatencyMs?: number;

  constructor(public cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {}

  get enabled() {
    return this.cfg.provider === 'ollama' || !!this.cfg.apiKey;
  }

  get provider() { return this.cfg.provider === 'ollama' ? 'Local AI · Ollama' : 'Nebius Token Factory'; }
  get source(): 'local-ai' | 'nemotron' { return this.cfg.provider === 'ollama' ? 'local-ai' : 'nemotron'; }

  get model() {
    return this.resolvedModel ?? this.cfg.model;
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.cfg.timeoutMs): Promise<any> {
    if (!this.enabled) throw new LlmError('no-credentials', 'No AI provider configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: init.signal ? AbortSignal.any([ctrl.signal,init.signal]) : ctrl.signal,
        headers: { ...(this.cfg.provider !== 'ollama' && this.cfg.apiKey ? {Authorization: `Bearer ${this.cfg.apiKey}`} : {}), 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
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
    if (this.cfg.provider === 'ollama') {
      const list = await this.request('/api/tags', {method:'GET'}, 3000);
      const ids: string[] = (list.models ?? []).map((m: any) => m.name);
      const pick = this.cfg.model ? ids.find(id => id === this.cfg.model) : ids.find(id => /^qwen3\.5:/i.test(id)) ?? ids.find(id => !/embed/i.test(id));
      if (!pick) throw new LlmError('no-model', 'Configured local model is not installed. No model was downloaded.');
      return (this.resolvedModel = pick);
    }
    if (this.resolvedModel) return this.resolvedModel;
    if (this.cfg.model) return (this.resolvedModel = this.cfg.model);
    const list = await this.request('/models', { method: 'GET' }, Math.min(this.cfg.timeoutMs, 8000));
    const ids: string[] = (list?.data ?? []).map((m: any) => m.id).filter(Boolean);
    const pick = PREFERRED_MODELS.find((p) => ids.includes(p)) ?? ids.find((id) => /nemotron/i.test(id)) ?? ids.find((id) => /^nvidia\//i.test(id));
    if (!pick) throw new LlmError('no-model', `no NVIDIA model found among ${ids.length} available models`);
    return (this.resolvedModel = pick);
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; schema?: object; signal?:AbortSignal } = {}): Promise<{ text: string; model: string; latencyMs: number }> {
    const model = await this.resolveModel();
    const t0 = Date.now();
    // Nemotron reasoning models: "/no_think" disables the long reasoning trace for snappy, structured replies.
    const msgs = /nemotron/i.test(model) && messages[0]?.role === 'system' ? [{ ...messages[0], content: `/no_think\n${messages[0].content}` }, ...messages.slice(1)] : messages;
    try {
      const local = this.cfg.provider === 'ollama';
      const json = await this.request(local ? '/api/chat' : '/chat/completions', {
        method: 'POST',
        signal:opts.signal,
        body: JSON.stringify(local ? {model, messages: msgs, stream:false, think:false, format:opts.schema ?? 'json', keep_alive:this.cfg.keepAlive ?? 0, options:{num_ctx:opts.schema?8192:4096,num_predict:opts.maxTokens ?? 700, temperature:opts.temperature ?? .4}} : { model, messages: msgs, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.4 }),
      });
      const text = local ? json?.message?.content : json?.choices?.[0]?.message?.content;
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
