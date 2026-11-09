// advisorDispatch — isolated, stateless cloud-advisor completion call.
//
// The cloud advisor is invoked as a SINGLE, self-contained /chat/completions
// request to the advisor provider's OpenAI-compatible gateway. The request
// body contains exactly two messages — the advisor system prompt
// (advisorBlock, with optional domain focus) and the one masked query
// (advisoryFrame) — and NOTHING else. No session history, no tools, and no
// local file context ever reach the cloud model.
//
// This is the privacy boundary of the pipeline. Because the call is
// stateless, the main session model never changes: there is no mid-session
// model switch — the tool simply awaits this call and returns the unmasked
// answer inline.
//
// Gateway discovery (baseUrl + optional apiKey) is parsed from
// ~/.omp/agent/models.yml by gateway.loadProvider().
import { advisorBlock, advisoryFrame } from "./cloudAdvisor.ts";
import { loadProvider, type ProviderEndpoint } from "./gateway.ts";

export interface AdvisorDispatchResult {
  ok: boolean;
  /** Raw (still-masked) advisor response text, present when ok. */
  text?: string;
  /** Human-readable failure reason, present when !ok. */
  error?: string;
}

/** Split a "provider/model" selector into its parts. */
export function splitSelector(selector: string): { provider: string; model: string } {
  const i = selector.indexOf("/");
  if (i < 0) return { provider: "", model: selector };
  return { provider: selector.slice(0, i), model: selector.slice(i + 1) };
}

/**
 * Run one isolated advisor completion. The cloud model sees only
 * [advisorBlock(focus), advisoryFrame(maskedQuery)] — a fresh two-message
 * conversation with no history and no tools.
 */
export async function dispatchIsolatedAdvisor(
  selector: string,
  maskedQuery: string,
  timeoutMs = 120000,
  focus?: string,
): Promise<AdvisorDispatchResult> {
  const { provider, model } = splitSelector(selector);
  if (!provider) {
    return {
      ok: false,
      error: `advisorModel "${selector}" must be a provider/model selector — the advisor dispatches through the provider's OpenAI-compatible gateway.`,
    };
  }

  const gw: ProviderEndpoint | null = loadProvider(provider);
  if (!gw) {
    return {
      ok: false,
      error: `Provider "${provider}" not found in ~/.omp/agent/models.yml or has no baseUrl. The advisor needs an OpenAI-compatible endpoint for "${provider}".`,
    };
  }

  const url = gw.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gw.apiKey) headers["Authorization"] = `Bearer ${gw.apiKey}`;
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 4096,
    messages: [
      { role: "system", content: advisorBlock(focus) },
      { role: "user", content: advisoryFrame(maskedQuery) },
    ],
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      error: `advisor request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const detail = await safeBodyText(res);
    return {
      ok: false,
      error: `gateway /chat/completions for "${provider}" returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: `advisor returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = extractContent(data);
  if (!text) {
    return { ok: false, error: "advisor returned an empty response" };
  }
  return { ok: true, text };
}

/** Best-effort capture of an error body for logging (truncated). */
async function safeBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Pull choices[0].message.content out of an OpenAI /chat/completions body. */
function extractContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  if (!("choices" in data) || !Array.isArray(data.choices)) return null;

  const first = data.choices[0];
  if (!first || typeof first !== "object" || !("message" in first)) return null;

  const message = first.message;
  if (!message || typeof message !== "object" || !("content" in message)) return null;

  const content = message.content;
  if (typeof content !== "string" || !content.trim()) return null;
  return content;
}