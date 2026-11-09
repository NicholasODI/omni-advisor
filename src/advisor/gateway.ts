// gateway — discover and query OpenAI-compatible provider endpoints.
//
// Standalone module (node: only). Advisor endpoints are provider blocks in
// `~/.omp/agent/models.yml` (e.g. `codex-lb:` with `baseUrl` and `apiKey`).
// Any provider with an OpenAI-compatible `baseUrl` works as the advisor
// gateway; the root functions reject/return-null on any failure and callers
// treat that as "unavailable" (the local model never blocks on quota data).
//
// `GET {baseUrl}/usage`     — gateway-specific token-limit report. Optional:
//                             many gateways 404 it (e.g. the codex-lb proxy
//                             documents it; stock OpenAI/Ollama do not have
//                             it). Callers must treat rejection as silent.
// `GET {baseUrl}/models`    — standard OpenAI model roster, for tab-completion.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OMP_MODELS_YML = join(homedir(), ".omp", "agent", "models.yml");

export interface ProviderEndpoint {
  provider: string;
  baseUrl: string;
  /** Null when the provider block has no apiKey (keyless local gateways). */
  apiKey: string | null;
}

export interface UsageLimit {
  limit_type: string;
  limit_window: string;
  max_value: number;
  current_value: number;
  remaining_value: number;
  reset_at?: string;
  source?: string;
  model_filter?: string | null;
}

export interface GatewayUsageReport {
  request_count?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  total_cost_usd?: number;
  limits?: UsageLimit[];
  upstream_limits?: UsageLimit[];
  account_pool_usage?: Record<string, number>;
}

/** Parse the provider block named `providerName` (baseUrl + apiKey) out of
 *  ~/.omp/agent/models.yml. Returns null when the file or block is absent. */
export function loadProvider(providerName: string): ProviderEndpoint | null {
  let text: string;
  try {
    text = readFileSync(OMP_MODELS_YML, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let blockIndent = 0;
  let baseUrl = "";
  let apiKey = "";
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)([^\s:]+):\s*(?:#.*)?$/);
      if (m && m[2] === providerName) {
        inBlock = true;
        blockIndent = m[1].length;
      }
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= blockIndent && line.trim() !== "") break; // left the block
    const m2 = line.match(/^\s*(baseUrl|apiKey):\s*(\S+)\s*$/);
    if (m2) {
      if (m2[1] === "baseUrl") baseUrl = m2[2];
      else apiKey = m2[2];
    }
  }
  if (!baseUrl) return null;
  return { provider: providerName, baseUrl, apiKey: apiKey || null };
}

/** Fetch the gateway's usage/limit report. Rejects on any failure; callers
 *  treat a rejection as "quota data unavailable" and log nothing. */
export async function fetchGatewayUsage(gw: ProviderEndpoint, timeoutMs = 8000): Promise<GatewayUsageReport> {
  const url = gw.baseUrl.replace(/\/$/, "") + "/usage";
  const headers: Record<string, string> = {};
  if (gw.apiKey) headers["Authorization"] = `Bearer ${gw.apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`gateway /usage returned HTTP ${res.status}`);
  const body = (await res.json()) as GatewayUsageReport;
  if (!body || typeof body !== "object") throw new Error("gateway /usage returned a non-object body");
  return body;
}

export interface GatewayModel {
  id: string;
  displayName?: string;
  description?: string;
}

/** Fetch the gateway's model roster (GET {baseUrl}/models). Rejects on any
 *  failure; callers treat a rejection as "roster unavailable". */
export async function fetchGatewayModels(gw: ProviderEndpoint, timeoutMs = 8000): Promise<GatewayModel[]> {
  const url = gw.baseUrl.replace(/\/$/, "") + "/models";
  const headers: Record<string, string> = {};
  if (gw.apiKey) headers["Authorization"] = `Bearer ${gw.apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`gateway /models returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: unknown; metadata?: { display_name?: unknown; description?: unknown } }>;
  };
  if (!body || !Array.isArray(body.data)) throw new Error("gateway /models returned a non-list body");
  return body.data
    .filter(
      (m): m is { id: string; metadata?: { display_name?: string; description?: string } } =>
        typeof m?.id === "string" && m.id.length > 0,
    )
    .map((m) => ({
      id: m.id,
      displayName: typeof m.metadata?.display_name === "string" ? m.metadata.display_name : undefined,
      description: typeof m.metadata?.description === "string" ? m.metadata.description : undefined,
    }));
}

/** One compact line per limit window, for debug.log. */
export function formatLimitLines(report: GatewayUsageReport): string[] {
  const lines: string[] = [];
  const fmt = (l: UsageLimit, label: string) => {
    lines.push(
      `${label} ${l.limit_window} ${l.limit_type}: ${l.current_value}/${l.max_value} used, ${l.remaining_value} remaining` +
        (l.reset_at ? ` (resets ${l.reset_at})` : "") +
        (l.source ? ` [${l.source}]` : ""),
    );
  };
  for (const l of report.limits ?? []) fmt(l, "key");
  for (const l of report.upstream_limits ?? []) fmt(l, "upstream");
  if (report.account_pool_usage) {
    lines.push(
      `pool headroom: ` +
        Object.entries(report.account_pool_usage)
          .map(([k, v]) => `${k} ${v}%`)
          .join(", "),
    );
  }
  if (typeof report.total_cost_usd === "number") {
    lines.push(`lifetime for this key: ${report.request_count ?? "?"} requests, ${report.total_tokens ?? "?"} tokens, $${report.total_cost_usd.toFixed(4)}`);
  }
  return lines;
}