import type { AdvisorPhase } from './advisorStream.ts';
import { advisorBlock, advisoryFrame } from './cloudAdvisor.ts';
import { assertAbstract } from './planning.ts';
import { splitSelector, type AdvisorDispatchResult } from './advisorDispatch.ts';

/** Structural facade keeps standalone tests independent of the OMP installation. */
export interface OmpRegistry {
  getAvailable(): Array<{ provider: string; id: string; name?: string }>;
  find(provider: string, id: string): any;
  getApiKeyAndHeaders(model: any): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}
type Complete = (model: any, context: any, options: any) => Promise<any>;
export async function dispatchOmpAdvisor(registry: OmpRegistry, selector: string, query: string,
  timeoutMs = 120000, focus?: string, signal?: AbortSignal, complete?: Complete, onPhase?: (phase: AdvisorPhase) => void, streamOverride?: any): Promise<AdvisorDispatchResult> {
  try {
    assertAbstract(query); if (focus) assertAbstract(focus);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const { provider, model: id } = splitSelector(selector);
    const model = registry.find(provider, id);
    if (!model) return { ok: false, error: 'Selected model is not in the OMP registry.' };
    const auth = await registry.getApiKeyAndHeaders(model);
    combined.throwIfAborted();
    if (!auth.ok) return { ok: false, error: 'OMP could not authenticate the selected provider.' };
    // Loaded only in OMP mode; the host owns provider adapters and authentication.
    const context = {
      systemPrompt: advisorBlock(focus),
      messages: [{ role: 'user', content: advisoryFrame(query), timestamp: Date.now() }],
    };
    const options = { apiKey: auth.apiKey, headers: auth.headers, signal: combined, maxTokens: 4096 };
    let result;
    if (onPhase && !complete) {
      const stream = streamOverride ?? (await import('@oh-my-pi/pi-ai')).stream;
      const events = stream(model, context, options);
      for await (const event of events) {
        if (event.type === 'thinking_start' || event.type === 'thinking_delta') onPhase('thinking');
        if (event.type === 'text_start' || event.type === 'text_delta') onPhase('answering');
      }
      result = await events.result();
    } else {
      const run = complete ?? (await import('@oh-my-pi/pi-ai')).complete;
      result = await run(model, context, options);
    }
    if (result.stopReason === 'error' || result.stopReason === 'aborted' || result.stopReason === 'length') {
      return { ok: false, error: 'OMP consultation failed, was cancelled, or exceeded the output budget.' };
    }
    const text = result.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    if (!text?.trim() || text.length > 256000) return { ok: false, error: 'OMP returned an empty or oversized plan.' };
    const u = result.usage;
    return { ok: true, text, ...(Number.isFinite(u?.input) && u.input >= 0 && Number.isFinite(u?.output) && u.output >= 0 ? { usage: { input: u.input, output: u.output } } : {}) };
  } catch { return { ok: false, error: signal?.aborted ? 'Consultation cancelled.' : 'OMP consultation failed; verify model availability and credentials.' }; }
}
