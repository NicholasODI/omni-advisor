// usageTracker — per-session, per-model token and cost accounting.
//
// Standalone module (node: only). Feeds the [MODEL_USAGE] entries in the
// append-only session log so the hybrid savings (self-hosted local executor
// at $0 vs billed advisor tokens) are visible per turn and per session.
//
// Cost: rates are an OPTIONAL parameter. Without a rate table the extension
// bills $0 — token counts remain useful and costs never pretend to be
// accurate. (ns-advisor carries a hardcoded catalog-rate table; a maintainable
// omni-advisor rate table is a later addition, see README.)
//
// Persistence: per-session sidecar `logs/<key>.usage.json` (same pattern as
// the cipher sidecar) — persisted after every recordUsage, hydrated lazily
// on first access, removed by clearUsage.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./logger.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  costUsd: number;
}

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Optional higher tier above a context threshold. */
  longContext?: {
    inputThreshold: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface UsageInput {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageRow extends UsageTotals {
  model: string;
}

interface SessionUsage {
  models: Map<string, UsageTotals>;
}

const sessions = new Map<string, SessionUsage>();

function sidecarPath(key: string): string {
  return join(LOG_DIR, `${key}.usage.json`);
}

/** Best-effort: accounting persistence must never break the turn. */
function persist(key: string, s: SessionUsage): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(sidecarPath(key), JSON.stringify({ models: [...s.models.entries()] }));
  } catch {
    // ignore
  }
}

/** Hydrate a session's ledger from its sidecar (undefined when absent/corrupt). */
function loadSidecar(key: string): Map<string, UsageTotals> | undefined {
  try {
    const p = sidecarPath(key);
    if (!existsSync(p)) return undefined;
    const data = JSON.parse(readFileSync(p, "utf8")) as { models?: [string, UsageTotals][] };
    const m = new Map<string, UsageTotals>();
    for (const [model, t] of data.models ?? []) m.set(model, t);
    return m.size ? m : undefined;
  } catch {
    return undefined;
  }
}

function sessionUsage(key: string): SessionUsage {
  let s = sessions.get(key);
  if (!s) {
    s = { models: loadSidecar(key) ?? new Map() };
    sessions.set(key, s);
  }
  return s;
}

export function messageCost(usage: UsageInput, rates?: ModelCostRates): number {
  if (!rates) return 0;
  const r = usage.input > 0 && rates.longContext && usage.input > rates.longContext.inputThreshold ? rates.longContext : rates;
  const toUsd = (tokens: number, rate: number) => (tokens / 1e6) * rate;
  return (
    toUsd(usage.input, r.input) +
    toUsd(usage.output, r.output) +
    toUsd(usage.cacheRead ?? 0, r.cacheRead) +
    toUsd(usage.cacheWrite ?? 0, r.cacheWrite)
  );
}

/** Accumulate one assistant message's usage under `modelKey` (provider/id). */
export function recordUsage(key: string, modelKey: string, usage: UsageInput, rates?: ModelCostRates): void {
  const s = sessionUsage(key);
  let t = s.models.get(modelKey);
  if (!t) {
    t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, costUsd: 0 };
    s.models.set(modelKey, t);
  }
  t.input += usage.input;
  t.output += usage.output;
  t.cacheRead += usage.cacheRead ?? 0;
  t.cacheWrite += usage.cacheWrite ?? 0;
  t.messages += 1;
  t.costUsd += messageCost(usage, rates);
  persist(key, s);
}

export function usageSummary(key: string): UsageRow[] {
  const s = sessionUsage(key);
  return [...s.models.entries()].map(([model, t]) => ({ model, ...t }));
}

export function usageTotals(key: string): UsageTotals {
  const rows = usageSummary(key);
  return rows.reduce(
    (acc, r) => ({
      input: acc.input + r.input,
      output: acc.output + r.output,
      cacheRead: acc.cacheRead + r.cacheRead,
      cacheWrite: acc.cacheWrite + r.cacheWrite,
      messages: acc.messages + r.messages,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, costUsd: 0 },
  );
}

/** Drop one session's accounting (or all when key is omitted). */
export function clearUsage(key?: string): void {
  if (key === undefined) {
    sessions.clear();
    try {
      for (const f of readdirSync(LOG_DIR)) {
        if (f.endsWith(".usage.json")) unlinkSync(join(LOG_DIR, f));
      }
    } catch {
      // best effort
    }
  } else {
    sessions.delete(key);
    try {
      unlinkSync(sidecarPath(key));
    } catch {
      // already absent
    }
  }
}