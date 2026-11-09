import { readAdvisorStream, type AdvisorPhase } from './advisorStream.ts';
import { advisorBlock, advisoryFrame } from './cloudAdvisor.ts';
import { loadProvider } from './gateway.ts';
import { assertAbstract } from './planning.ts';
export interface ProviderConfig {
  baseUrl: string;
  api: 'openai' | 'anthropic';
  apiKeyEnv?: string;
  maxOutputTokens?: number;
  stream?: boolean;
}
export interface AdvisorDispatchResult {
  ok: boolean; text?: string; error?: string;
  usage?: { input: number; output: number };
}
export function splitSelector(selector: string): { provider: string; model: string } {
  const i = selector.indexOf('/');
  return i < 0 ? { provider: '', model: selector } : { provider: selector.slice(0, i), model: selector.slice(i + 1) };
}
export async function dispatchIsolatedAdvisor(selector: string, query: string, timeoutMs = 120000, focus?: string,
  providers?: Record<string, ProviderConfig>, signal?: AbortSignal, onPhase?: (phase: AdvisorPhase) => void): Promise<AdvisorDispatchResult> {
  try {
    assertAbstract(query);
    if (focus) assertAbstract(focus);
    const { provider, model } = splitSelector(selector);
    if (!provider || !model) throw new Error('Use a provider/model selector.');
    const configured = providers?.[provider];
    const legacy = configured ? null : loadProvider(provider);
    if (!configured && !legacy) throw new Error('Provider is not configured.');
    const base = new URL(configured?.baseUrl ?? legacy!.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Provider baseUrl must be HTTPS without credentials, query, or fragment.');
    const api = configured?.api ?? 'openai';
    if (!['openai', 'anthropic'].includes(api)) throw new Error('Unsupported provider API format.');
    const key = configured?.apiKeyEnv ? process.env[configured.apiKeyEnv] : legacy?.apiKey;
    if (configured?.apiKeyEnv && !key) throw new Error(`Missing API-key environment variable: ${configured.apiKeyEnv}`);
    const tokens = configured?.maxOutputTokens ?? 4096;
    if (!Number.isInteger(tokens) || tokens < 256 || tokens > 16384) throw new Error('maxOutputTokens must be an integer from 256 to 16384.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid advisor timeout.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers[api === 'anthropic' ? 'x-api-key' : 'Authorization'] = api === 'anthropic' ? key : `Bearer ${key}`;
    if (api === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    const system = advisorBlock(focus);
    const messages = [{ role: 'user', content: advisoryFrame(query) }];
    const body = api === 'anthropic'
      ? { model, max_tokens: tokens, system, messages }
      : { model, max_tokens: tokens, messages: [{ role: 'system', content: system }, ...messages] };
    const streaming = !!onPhase && configured?.stream !== false;
    const payload = streaming ? { ...body, stream: true, ...(api === 'openai' ? { stream_options: { include_usage: true } } : {}) } : body;
    const res = await fetch(base.href.replace(/\/$/, '') + (api === 'anthropic' ? '/messages' : '/chat/completions'), {
      method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Provider returned HTTP ${res.status}.`); }
    if (res.headers.get('content-type')?.includes('text/event-stream')) return await readAdvisorStream(res, api, onPhase);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty provider response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256000) throw new Error('Provider response too large.'); chunks.push(value); } }
    finally { await reader.cancel(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.stop_reason === 'max_tokens' || data.choices?.[0]?.finish_reason === 'length') throw new Error('Plan truncated; increase maxOutputTokens or narrow the brief.');
    const text = api === 'anthropic' ? data.content?.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('\n') : data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Provider returned no text plan.');
    const input = api === 'anthropic' ? data.usage?.input_tokens : data.usage?.prompt_tokens;
    const output = api === 'anthropic' ? data.usage?.output_tokens : data.usage?.completion_tokens;
    return { ok: true, text, ...(Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? { usage: { input, output } } : {}) };
  } catch (err) {
    // Never reflect arbitrary upstream bodies or network errors containing credentials.
    return { ok: false, error: signal?.aborted ? 'Consultation cancelled.' : err instanceof Error && /^(Provider |Use |Missing |Unsupported |Invalid |maxOutput|Plan |Privacy |Provide |Empty )/.test(err.message) ? err.message : 'Consultation failed; check provider configuration or retry later.' };
  }
}
