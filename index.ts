// omni-advisor — Local-First coding pipeline with an ISOLATED Cloud Advisor.
//
// Domain-generalization of the ns-advisor extension (which ns-advisor
// owner keeps for NetSuite; both may coexist — omni-advisor uses distinct
// tool/command names and its own logs/ sidecars).
//
//   * The local session model is the PRIMARY EXECUTOR: it receives every
//     prompt, reads/writes files, runs tests, drives tooling. The session
//     model NEVER changes — there is no mid-session model switch.
//   * The cloud advisor is a STATELESS, ISOLATED consultant. Each
//     ask_advisor call is a single self-contained /chat/completions request
//     to the advisor provider's OpenAI-compatible gateway (discovered from
//     ~/.omp/agent/models.yml) carrying exactly two messages — the advisor
//     system prompt (advisorBlock + optional domain focus) and the one
//     masked query (advisoryFrame). No session history, no tools, and no
//     local file context ever reach the cloud model (see advisorDispatch.ts).
//   * Abstract briefs are validated and masked; no automatic context sharing.
//   * Cloud access is enforced by the session gate.
//
// Controls:
//   /omni-advisor on | off | status | model [provider/model] | model clear
//   /omni-cipher-status   — inspect active session mappings
//   /omni-usage           — per-model token + cost summary (+ quota when available)
//   /omni-cipher-clear    — reset mappings (log files are append-only and kept)
//
// Configuration: omni-advisor.config.json next to this file
//   { "enabledByDefault": false,
//     "advisorModel": "codex-lb/gpt-6.1-sol",
//     "advisorTimeoutMs": 120000,
//     "advisorFocus": "TypeScript + AWS EKS",
//     "semanticTerms": { "my-corp-inc": "WORKSPACE" } }
// Env overrides: OMNI_ADVISOR_MODEL=provider/model, OMNI_ADVISOR_FOCUS="..."
//
// User-level extension: no changes to omp itself. Disable via
// `disabledExtensions: [extension-module:omni-advisor]` or delete this folder.

import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { assertAbstract, planningText, validateBrief, PrivacyError } from "./planning.ts";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { executorNudge, toolResponseFrame } from "./cloudAdvisor.ts";
import * as cipher from "./cipher.ts";
import * as usage from "./usageTracker.ts";
import {
  fetchGatewayModels,
  fetchGatewayUsage,
  formatLimitLines,
  loadProvider,
  type GatewayUsageReport,
} from "./gateway.ts";
import { dispatchIsolatedAdvisor, splitSelector, type ProviderConfig } from "./advisorDispatch.ts";
import { SessionMetrics } from "./sessionMetrics.ts";
import { PlanningGate, enforcedPlanningPrompt } from "./planningGate.ts";
import { dispatchOmpAdvisor } from "./ompAdvisor.ts";
import { log, logPath } from "./logger.ts";

/**
 * Per-process config. Read once at extension load; a reload picks up edits.
 * `semanticTerms` are auto-registered as cipher terms for every session.
 */
interface OmniAdvisorConfig {
  enabledByDefault?: boolean;
  enforcePlanning?: boolean;
  providers?: Record<string, ProviderConfig>;
  advisorSource?: "config" | "omp";
  maxConsultationsPerSession?: number;
  /** "provider/model" — the provider must be an models.yml block with a baseUrl. */
  advisorModel?: string;
  /** Max time to wait for the isolated advisor completion (ms). Default 120000. */
  advisorTimeoutMs?: number;
  /** Optional domain hint appended to the advisor's system prompt. */
  advisorFocus?: string;
  semanticTerms?: Record<string, cipher.SemanticTermType>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "omni-advisor.config.json");
/** Fallback advisor model when neither env nor config specifies one. */
const DEFAULT_ADVISOR_MODEL = "codex-lb/gpt-6.1-sol";

function loadConfig(): OmniAdvisorConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as OmniAdvisorConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let config: OmniAdvisorConfig = loadConfig();

/** Resolved advisor model selector (provider/model). Override > env > config > default. */
function advisorSelector(): string {
  return advisorModelOverride || process.env.OMNI_ADVISOR_MODEL || config.advisorModel || DEFAULT_ADVISOR_MODEL;
}

/** Optional domain focus for the advisor prompt. Env > config. */
function advisorFocus(): string | undefined {
  return process.env.OMNI_ADVISOR_FOCUS || config.advisorFocus;
}

/**
 * Advisor-model autocomplete options. The gateway roster is fetched in the
 * background (10-minute TTL) so the synchronous completions callback never
 * blocks; until the first fetch lands, static candidates are offered.
 */
interface AdvisorModelOption {
  label: string;
  description: string;
}
let modelOptions: { ts: number; items: AdvisorModelOption[] } | undefined;
let modelOptionsInFlight = false;

function refreshModelOptions(): void {
  if (modelOptions && Date.now() - modelOptions.ts < 600000) return;
  if (modelOptionsInFlight) return;
  modelOptionsInFlight = true;
  const sel = advisorSelector();
  const { provider } = splitSelector(sel);
  const gw = loadProvider(provider);
  if (config.providers?.[provider] || !gw) { modelOptionsInFlight = false; return; }
  void fetchGatewayModels(gw ?? { provider, baseUrl: "", apiKey: null }, 8000)
    .then((data) => {
      const items: AdvisorModelOption[] = data.map((m) => ({
        label: `${provider}/${m.id}`,
        description: m.description || m.displayName || m.id,
      }));
      items.unshift({ label: sel, description: "current advisor" });
      modelOptions = { ts: Date.now(), items: dedupeByLabel(items) };
      modelOptionsInFlight = false;
    })
    .catch(() => {
      // Roster unavailable — static candidates only (see advisorModelOptions).
      modelOptionsInFlight = false;
    });
}

function dedupeByLabel(items: AdvisorModelOption[]): AdvisorModelOption[] {
  const seen: Record<string, true> = {};
  const out: AdvisorModelOption[] = [];
  for (const it of items) {
    if (seen[it.label]) continue;
    seen[it.label] = true;
    out.push(it);
  }
  return out;
}

function advisorModelOptions(): AdvisorModelOption[] {
  const opts = modelOptions?.items ?? [];
  const sel = advisorSelector();
  const { provider, model: bare } = splitSelector(sel);
  const configured = config.advisorModel && config.advisorModel !== sel ? [config.advisorModel] : [];
  const candidates = [sel, ...configured, process.env.OMNI_ADVISOR_MODEL ?? ""].filter((s) => s.length > 0);
  const rosterHas = (label: string) => opts.some((o) => o.label === label);
  const items: AdvisorModelOption[] = [];
  for (const label of candidates) {
    if (!label.includes("/")) continue;
    if (rosterHas(label)) continue;
    items.push({ label, description: "configured / fallback" });
  }
  for (const o of opts) {
    if (items.some((i) => i.label === o.label)) continue;
    items.push(o);
  }
  return items;
}

/**
 * Effective advisor nudge gate for a session.
 *   explicit per-session override > config.enabledByDefault > false
 */
function isAdvisorEnabled(key: string): boolean {
  const explicit = gateOnBySession.get(key);
  if (explicit !== undefined) return explicit;
  if (config.enabledByDefault === true) return true;
  if (config.enabledByDefault === false) return false;
  return false;
}

/** Per-session memo: config semanticTerms must be registered for EVERY
 *  session that uses the advisor, not just the first (process outlives
 *  sessions in long-running omp). */
const configTermsEnsuredFor = new Set<string>();
function ensureConfigTerms(key: string): void {
  if (configTermsEnsuredFor.has(key)) return;
  configTermsEnsuredFor.add(key);
  const terms0 = config.semanticTerms;
  if (!terms0) return;
  const terms = Object.entries(terms0)
    .map(([raw, type]) => ({ raw: raw.trim(), type: type as cipher.SemanticTermType }))
    .filter((t) => t.raw.length > 0);
  if (terms.length === 0) return;
  const before = cipher.status(key).count;
  cipher.registerTerms(key, terms);
  const after = cipher.status(key).count;
  const registered = after - before;
  const skipped = terms.length - registered;
  log(key, "CIPHER_INIT", `Registered ${registered} config semantic terms for this session${skipped ? ` (${skipped} already known)` : ""}.`);
}

/** Process-lifetime advisor model override set via /omni-advisor model. */
let advisorModelOverride: string | undefined;
let sourceOverride: "config" | "omp" | undefined;
function advisorSource(): "config" | "omp" { return sourceOverride ?? config.advisorSource ?? "config"; }

/** Per-session advisor-nudge on/off state, persisted to
 *  logs/omni-advisor-gates.json so a session left "on" (or "off") keeps its
 *  state across omp restarts. */
const GATES_FILE = join(__dirname, "logs", "omni-advisor-gates.json");

function loadGates(): Map<string, boolean> {
  try {
    if (!existsSync(GATES_FILE)) return new Map();
    const data = JSON.parse(readFileSync(GATES_FILE, "utf8")) as Record<string, boolean>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function persistGates(): void {
  try {
    mkdirSync(dirname(GATES_FILE), { recursive: true });
    writeFileSync(GATES_FILE, JSON.stringify(Object.fromEntries(gateOnBySession)));
  } catch {
    // best effort
  }
}

const gateOnBySession = loadGates();
const planningGate = new PlanningGate();
const planningOverrides = new Map<string, boolean>();
function planningEnforced(key: string): boolean { return planningOverrides.get(key) ?? config.enforcePlanning === true; }
// Compaction continuation is not a new task. Real user input takes precedence.
const compactedSessions = new Set<string>();
const freshInputSessions = new Set<string>();
const checklists = new Map<string, Array<{ id: string; requirement: string; status: string; evidence?: string }>>();
const metrics = new Map<string, SessionMetrics>();
function sessionMetrics(key: string): SessionMetrics {
  if (!metrics.has(key)) metrics.set(key, new SessionMetrics());
  return metrics.get(key)!;
}
const consultationCounts = new Map<string, number>();
const pendingConsultations = new Set<string>();
const lastQuotaBySession = new Map<string, { ts: number; report: GatewayUsageReport }>();

/** Refresh the advisor gateway's usage report and cache it per session.
 *  Best-effort: many gateways have no /usage endpoint (404) — that is fine. */
async function refreshQuota(key: string): Promise<void> {
  const { provider } = splitSelector(advisorSelector());
  const gw = loadProvider(provider);
  if (!gw) return;
  try {
    const report = await fetchGatewayUsage(gw, 8000);
    lastQuotaBySession.set(key, { ts: Date.now(), report });
    const lines = formatLimitLines(report);
    if (lines.length) log(key, "CLOUD_QUOTA", lines.join(" | "));
  } catch {
    // quota endpoint unavailable — silent by design
  }
}

let unknownKeyWarned = false;
function sessionKey(ctx: { sessionManager: unknown }): string {
  const sm = ctx.sessionManager as { getSessionFile?: () => string };
  const f = sm?.getSessionFile?.();
  if (!f && !unknownKeyWarned) {
    // Silent shared-bucket fallback is a data-leak footgun: terms registered
    // under "unknown" are shared by every ctx-degraded session. Make it loud.
    unknownKeyWarned = true;
    log("unknown", "ERROR", "sessionKey fallback: ctx.sessionManager.getSessionFile() unavailable; cipher bucketing degrades to shared 'unknown' key (terms persist across sessions) until omp restart");
  }
  return f ? createHash("sha256").update(f).digest("hex") : "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `…[truncated ${s.length - max} chars]` : s;
}

export default function omniAdvisor(pi: ExtensionAPI): void {
  const z = pi.zod;

  // ---------------------------------------------------------------------
  // Tool: ask_advisor — ISOLATED cloud-advisor dispatch
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "ask_advisor",
    label: "Ask Cloud Advisor",
    description:
      "Consult a generalist software architect for initial task planning (rough overview without local files/code), architecture, performance, concurrency, security, and unfamiliar-framework questions. Do NOT use for routine syntax or locally verifiable work—work solo ($0). The query is masked (sensitive values become OMNI_* placeholders), sent to an isolated cloud advisor with no access to your files, tools, or conversation history, and advice retains placeholders. Call advisor_status for real extension settings; do not infer them from OMP cfg://advisor.",
    parameters: z.object({
      objective: z.string().min(1).max(3000),
      stack: z.string().max(1000).optional(),
      components: z.string().max(2000).optional(),
      constraints: z.string().max(2000).optional(),
      facts: z.string().max(2000).optional(),
      questions: z.string().min(1).max(3000),
      previousPlan: z.string().max(2000).optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const stats = sessionMetrics(key);
      if (key === "unknown" || !isAdvisorEnabled(key)) {
        stats.blocked++;
        return { content: [{ type: "text", text: "Cloud consultation blocked: enable /omni-advisor on and use an isolated session. Continue locally." }], details: { status: "disabled" } };
      }
      const query = planningText(params);
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: ask_advisor requires a non-empty query." }],
          details: {},
        };
      }

      const limit = config.maxConsultationsPerSession;
      if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1 || (consultationCounts.get(key) ?? 0) >= limit)) || pendingConsultations.has(key)) {
        stats.blocked++;
        return { content: [{ type: "text", text: "Consultation budget exhausted or another consultation is pending. Continue with the local plan." }], details: { status: "budget" } };
      }
      const planningToken = planningGate.token(key);
      pendingConsultations.add(key);
      try {
        validateBrief(params);
        const focus = advisorFocus();
        if (focus) assertAbstract(focus, "advisorFocus");
        ensureConfigTerms(key);
        const masked = cipher.mask(query, key);
        log(
          key,
          "CLOUD_OUT",
          `ask_advisor query (masked, isolated dispatch): ${masked.length} characters`,
        );

        const sel = advisorSelector();
        consultationCounts.set(key, (consultationCounts.get(key) ?? 0) + 1);
        const safeFocus = focus ? cipher.mask(focus, key) : undefined;
        const dispatchStarted = Date.now();
        const result = advisorSource() === "omp"
          ? await dispatchOmpAdvisor(ctx.modelRegistry, sel, masked, config.advisorTimeoutMs, safeFocus, _signal)
          : await dispatchIsolatedAdvisor(sel, masked, config.advisorTimeoutMs, safeFocus, config.providers, _signal);

        stats.result(result.ok, Date.now() - dispatchStarted, result.usage);
        log(key, "METRICS", JSON.stringify(stats.snapshot()));
        if (!result.ok) {
          log(key, "ERROR", `advisor dispatch failed: ${result.error}`);
          return {
            content: [{ type: "text", text: `Error: cloud advisor unavailable — ${result.error}` }],
            details: {},
          };
        }

        planningGate.complete(key, planningToken);
        log(key, "CLOUD_IN", `Advisor response: ${result.text!.length} characters`);
        if (result.usage) usage.recordUsage(key, sel, result.usage);
        log(key, "PLAN", "Advisor plan received; placeholders retained.");
        // Keep placeholders unresolved: cloud output cannot select local secrets.
        const unmasked = result.text!;

        // Best-effort: keep the per-session quota display fresh after a cloud call.
        if (advisorSource() === "config" && !config.providers?.[splitSelector(sel).provider]) void refreshQuota(key);

        return {
          content: [{ type: "text", text: toolResponseFrame(unmasked) }],
          details: { advisor: sel },
        };
      } catch (err) {
        stats.blocked++;
        log(
          key,
          "ERROR",
          "ask_advisor validation or execution failed",
        );
        return {
          content: [{ type: "text", text: err instanceof PrivacyError ? err.message : "Consultation blocked by local validation. Check advisor_status and brief fields." }],
          details: {},
        };
      } finally {
        pendingConsultations.delete(key);
      }
    },
  });

  pi.registerTool({
    name: "advisor_checklist",
    label: "Local Plan Checklist",
    description: "Local only. Store or inspect a compact requirement-to-evidence checklist. Omit items to read. Before reporting completion reconcile every requirement; self-reported evidence is not independent verification. Never resend this local evidence to the cloud automatically.",
    parameters: z.object({ items: z.array(z.object({ id: z.string().min(1).max(40), requirement: z.string().min(1).max(500),
      status: z.enum(["pending", "passed", "failed", "unverified"]), evidence: z.string().max(1000).optional() })).max(50).optional() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      if (params.items) checklists.set(key, params.items.map(item => ({ ...item, status: item.status === "passed" && !item.evidence?.trim() ? "unverified" : item.status })));
      const items = checklists.get(key) ?? [];
      const summary = { items, complete: items.length > 0 && items.every(item => item.status === "passed"), verification: "local-model-reported; check evidence against actual results" };
      return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
    },
  });

  pi.registerTool({
    name: "advisor_status",
    label: "Advisor Status (Local)",
    description: "Read actual omni-advisor settings, planning state, provider configuration readiness, usage, and timing. Local only; no credential values, authentication refresh, or network calls. Configuration presence does not prove connectivity.",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const selector = advisorSelector();
      const { provider, model } = splitSelector(selector);
      const explicit = config.providers?.[provider];
      let readiness = "not configured";
      if (advisorSource() === "omp") {
        readiness = ctx.modelRegistry?.find(provider, model) ? "model registered; authentication and connectivity unverified" : "model unavailable";
      } else if (explicit) {
        readiness = explicit.apiKeyEnv && !process.env[explicit.apiKeyEnv] ? "required key environment variable missing" : "configuration present; connectivity unverified";
      } else if (loadProvider(provider)) readiness = "legacy configuration present; connectivity unverified";
      const status = { enabled: isAdvisorEnabled(key), isolatedSession: key !== "unknown", source: advisorSource(), model: selector,
        enforcedPlanning: planningEnforced(key), awaitingPlan: planningEnforced(key) && !planningGate.ready(key),
        pending: pendingConsultations.has(key), maxConsultationsPerSession: config.maxConsultationsPerSession ?? null,
        attemptedDispatches: consultationCounts.get(key) ?? 0, providerReadiness: readiness,
        advicePlaceholders: "retained", measurements: sessionMetrics(key).snapshot() };
      return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
    },
  });

  // ---------------------------------------------------------------------
  // Tool: register_masked_terms — extend the cipher at session start
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "register_masked_terms",
    label: "Register Masked Terms",
    description:
      "Register session-specific terms the regex sanitizer cannot see (workspace/repo names, hostnames, people's names, project codenames). Registered terms are mapped to OMNI_* placeholders for every outbound cloud payload in this session.",
    parameters: z.object({
      terms: z.array(
        z.object({
          term: z.string().describe("The exact real value to mask (e.g. 'acme-corp' or 'build-host-01')."),
          type: z
            .enum(["WORKSPACE", "HOST", "PERSON_OR_ORG", "SECRET", "OTHER"])
            .describe("Semantic category used for the OMNI_* placeholder."),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const terms = params.terms
        .map((t) => ({ raw: t.term.trim(), type: t.type as cipher.SemanticTermType }))
        .filter((t) => t.raw.length > 0);
      const before = cipher.status(key).count;
      cipher.registerTerms(key, terms);
      const after = cipher.status(key).count;
      const registered = after - before;
      const skipped = terms.length - registered;
      log(
        key,
        "CIPHER",
        `Registered ${registered} semantic terms${skipped > 0 ? ` (${skipped} already known)` : ""}; ${after} active mappings in this session.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Registered ${registered} new masked terms${skipped > 0 ? ` (${skipped} were already known)` : ""}. ${after} mappings now active in this session.`,
          },
        ],
        details: { registered, skipped, total: after },
      };
    },
  });

  // ---------------------------------------------------------------------
  // System-prompt nudge for the LOCAL model (advisor nudge gate).
  //
  // The session model is never switched, so this only ever injects the
  // executor nudge. The cloud advisor's own system prompt (advisorBlock) is
  // sent inside the isolated completion request, never here.
  // ---------------------------------------------------------------------
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") freshInputSessions.add(sessionKey(ctx));
  });
  pi.on("session_compact", async (_event, ctx) => {
    compactedSessions.add(sessionKey(ctx));
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const key = sessionKey(ctx);
    sessionMetrics(key).begin();
    const enforced = planningEnforced(key);
    const compactionContinuation = compactedSessions.has(key) && !freshInputSessions.has(key);
    compactedSessions.delete(key);
    freshInputSessions.delete(key);
    if (event.reason !== "revive" && !compactionContinuation) {
      checklists.delete(key);
      if (enforced) planningGate.begin(key);
    }
    if (!isAdvisorEnabled(key) && !enforced) return;
    return { systemPrompt: [...event.systemPrompt, executorNudge(), ...(enforced ? [enforcedPlanningPrompt, ...(planningGate.ready(key) ? ["A successful cloud plan is already approved for the current task. Continue local execution from the retained plan/checklist; compaction does not require another consultation."] : [])] : [])] };
  });

  pi.on("tool_call", async (event, ctx) => {
    const key = sessionKey(ctx);
    if (planningEnforced(key) && planningGate.blocked(key, event.toolName)) {
      return { block: true, reason: "Execution blocked by enforced planning. Use read/grep/glob/ls/find to gather local facts, then call ask_advisor with an abstract brief. A successful consultation unlocks execution for this prompt. If cloud access or budget is unavailable, report the blocker; the user can use /omni-advisor planning off." };
    }
    sessionMetrics(key).toolStart(event.toolCallId);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (sessionMetrics(sessionKey(ctx)).toolEnd(event.toolCallId, event.toolName, event.isError)) {
      return { content: [...event.content, { type: "text", text: "Local recovery hint: three consecutive failures for this tool. Inspect the failure, isolate a minimal reproduction, and change the diagnosis before retrying. Do not automatically consult the cloud." }] };
    }
  });
  pi.on("agent_end", async (_event, ctx) => {
    const key = sessionKey(ctx); sessionMetrics(key).end();
    log(key, "METRICS", JSON.stringify(sessionMetrics(key).snapshot()));
  });

  // ---------------------------------------------------------------------
  // Usage accounting for every model in the session (local + cloud advisor).
  // ---------------------------------------------------------------------
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg?.role !== "assistant") return;
    const u = msg.usage;
    if (!u) return;
    const key = sessionKey(ctx);
    const model = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : msg.model || "unknown";
    const usageInput = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 };
    usage.recordUsage(key, model, usageInput);
    log(
      key,
      "MODEL_USAGE",
      `${model}: in=${u.input} out=${u.output} cacheR=${u.cacheRead} cacheW=${u.cacheWrite} cost=unknown`,
    );
  });

  // ---------------------------------------------------------------------
  // Log the per-session totals when a session is torn down.
  // ---------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const tot = usage.usageTotals(key);
    log(
      key,
      "SESSION_END",
      `session closed: in=${tot.input} out=${tot.output} cacheR=${tot.cacheRead} msgs=${tot.messages} cost=unknown`,
    );
    gateOnBySession.delete(key);
    planningGate.clear(key);
    planningOverrides.delete(key);
    metrics.delete(key);
    checklists.delete(key);
    compactedSessions.delete(key);
    freshInputSessions.delete(key);
  });

  // ---------------------------------------------------------------------
  // Command: /omni-advisor on | off | status | model [provider/model]
  // ---------------------------------------------------------------------
  pi.registerCommand("omni-advisor", {
    description: "omni-advisor: control the cloud advisor (on / off / status / model)",
    getArgumentCompletions(arg: string) {
      const text = arg || "";
      const modelWord = text.match(/^model[ \t]+(\S*)$/i);
      if (modelWord) {
        refreshModelOptions();
        const prefix = modelWord[1].toLowerCase();
        const items = advisorModelOptions().filter((o) => {
          const l = o.label.toLowerCase();
          const bare = o.label.includes("/") ? o.label.slice(o.label.indexOf("/") + 1) : l;
          return l.startsWith(prefix) || bare.startsWith(prefix);
        });
        return items.length
          ? items.map((o) => ({ label: o.label, value: `model ${o.label}`, description: o.description }))
          : null;
      }
      const p = text.trim().toLowerCase();
      if (p.includes(" ")) return null;
      const subs = [
        { label: "planning on", value: "planning on", description: "Require abstract cloud planning before execution tools" },
        { label: "planning off", value: "planning off", description: "Disable planning enforcement" },
        { label: "on", value: "on", description: "Enable advisor nudge for this session" },
        { label: "off", value: "off", description: "Disable advisor nudge for this session" },
        { label: "status", value: "status", description: "Show gate state + resolved advisor model" },
        { label: "model omp", value: "model omp", description: "Choose from OMP instance models" },
        { label: "source omp", value: "source omp", description: "Use OMP model registry and credentials" },
        { label: "source config", value: "source config", description: "Use configured endpoints" },
        { label: "model", value: "model", description: "Select advisor model (model clear resets)" },
      ];
      const m = subs.filter((s) => s.label.startsWith(p));
      return m.length ? m : null;
    },
    handler: async (arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      const argNorm = (arg || "").trim().toLowerCase();
      const raw = (arg || "").trim();
      if (argNorm === "planning on" || argNorm === "planning off") {
        const enforce = argNorm === "planning on";
        planningOverrides.set(key, enforce);
        if (enforce) planningGate.begin(key); else planningGate.clear(key);
        ctx.ui.notify(`omni-advisor: enforced planning ${enforce ? "ON (cloud access must also be on)" : "OFF"}`, "info");
        return;
      }
      if (argNorm === "source omp" || argNorm === "source config") {
        sourceOverride = argNorm === "source omp" ? "omp" : "config";
        ctx.ui.notify(`omni-advisor: source=${advisorSource()}`, "info");
        return;
      }
      if (argNorm === "model omp") {
        const models = ctx.modelRegistry.getAvailable();
        if (!models.length) { ctx.ui.notify("omni-advisor: no available OMP models.", "warning"); return; }
        const labels = [...new Set(models.map((m) => `${m.provider}/${m.id}`))];
        const selected = await ctx.ui.select("Select OMP advisor model", labels);
        if (selected && labels.includes(selected)) {
          advisorModelOverride = selected;
          sourceOverride = "omp";
          ctx.ui.notify(`omni-advisor: OMP advisor=${selected}`, "info");
        }
        return;
      }
      if (/^model\b/i.test(raw)) {
        const spec = raw.slice(5).trim();
        if (!spec) {
          ctx.ui.notify(
            `omni-advisor: advisor=${advisorSelector()} (override: ${advisorModelOverride ?? "none"}; chain: override > OMNI_ADVISOR_MODEL > config > default)`,
            "info",
          );
          return;
        }
        if (spec.toLowerCase() === "clear") {
          advisorModelOverride = undefined;
          ctx.ui.notify(`omni-advisor: model override cleared; advisor=${advisorSelector()}`, "info");
          return;
        }
        if (!spec.includes("/")) {
          ctx.ui.notify(`omni-advisor: expected a provider/model selector, got "${spec}"`, "error");
          return;
        }
        advisorModelOverride = spec;
        log(key, "ADVISOR_MODEL", `advisor model override set to ${spec} (process lifetime; /omni-advisor model clear resets)`);
        ctx.ui.notify(
          `omni-advisor: advisor model = ${spec} (process lifetime; edit omni-advisor.config.json to persist)`,
          "info",
        );
        return;
      }
      if (argNorm === "on") {
        gateOnBySession.set(key, true);
        persistGates();
        ensureConfigTerms(key);
        ctx.ui.notify("omni-advisor: cloud advisor nudge ENABLED for this session (persisted across restarts).", "info");
        return;
      }
      if (argNorm === "off") {
        gateOnBySession.set(key, false);
        persistGates();
        ctx.ui.notify("omni-advisor: cloud advisor nudge DISABLED for this session (persisted across restarts).", "info");
        return;
      }
      const on = isAdvisorEnabled(key);
      const def = config.enabledByDefault === true;
      ctx.ui.notify(
        `omni-advisor: pipeline ${on ? "enabled" : "disabled"}; default=${def ? "enabled" : "disabled"}; advisor=${advisorSelector()} source=${advisorSource()} enforcedPlanning=${planningEnforced(key)} (isolated dispatch)`,
        "info",
      );
    },
  });

  // ---------------------------------------------------------------------
  // Command: /omni-cipher-status
  // ---------------------------------------------------------------------
  pi.registerCommand("omni-cipher-status", {
    description: "omni-advisor: show active cipher mappings for this session",
    handler: async (_arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      const st = cipher.status(key);
      if (st.count === 0) {
        ctx.ui.notify("omni-cipher: no mappings in this session yet.", "info");
        return;
      }
      const lines = [
        `omni-cipher: ${st.count} active mapping(s) for this session:`,
        ...st.entries.map((e) => `  ${e.placeholder} (${e.type})`),
        "",
        `Log files (kept, append-only):`,
        `  ${logPath(key)}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---------------------------------------------------------------------
  // Command: /omni-usage
  // ---------------------------------------------------------------------
  pi.registerCommand("omni-usage", {
    description: "omni-advisor: show token summary for this session",
    handler: async (_arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      const rows = usage.usageSummary(key);
      const sum = usage.usageTotals(key);
      if (sum.messages === 0) {
        ctx.ui.notify(`omni-usage: no token usage recorded. Consultation/timing: ${JSON.stringify(sessionMetrics(key).snapshot())}`, "info");
        return;
      }
      const lines: string[] = [
        `omni-usage (${key}): ${sum.messages} assistant message(s)`,
        `  input=${sum.input}  output=${sum.output}  cacheRead=${sum.cacheRead}  cacheWrite=${sum.cacheWrite}`,
        `  cost=unknown (no configured rate data)`,
        "",
        "  by model:",
        ...rows.map(
          (r) =>
            `    ${r.model}: in=${r.input} out=${r.output} cacheR=${r.cacheRead} cacheW=${r.cacheWrite} cost=unknown`,
        ),
      ];
      lines.push("", `  consultations/timing: ${JSON.stringify(sessionMetrics(key).snapshot())}`);
      const cached = lastQuotaBySession.get(key);
      if (cached) {
        const mins = Math.round((Date.now() - cached.ts) / 60000);
        lines.push("", `  advisor gateway quota (${mins}m ago):`);
        lines.push(...formatLimitLines(cached.report).map((l) => `    ${l}`));
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---------------------------------------------------------------------
  // Command: /omni-cipher-clear
  // ---------------------------------------------------------------------
  pi.registerCommand("omni-cipher-clear", {
    description: "omni-advisor: clear cipher mappings and usage for this session",
    handler: async (_arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      cipher.clearSession(key);
      configTermsEnsuredFor.delete(key);
      usage.clearUsage(key);
      ctx.ui.notify("omni-cipher: mappings and usage cleared for this session.", "info");
    },
  });
}