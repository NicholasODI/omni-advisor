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
//   * Zero data leakage: every outbound cloud payload is scrubbed by the
//     stateful cipher (deterministic spans for emails/keys/tokens/UUIDs/...
//     + value-group patterns + semantic terms registered via
//     register_masked_terms); every inbound cloud response is unmasked
//     before it reaches the local model.
//   * Per-session append-only logs in logs/ record [SANITIZE], [CIPHER],
//     [CLOUD_OUT], [CLOUD_IN], [UNMASK], [MODEL_USAGE], [CLOUD_QUOTA],
//     [ADVISOR_MODEL], [SESSION_END], [ERROR].
//
// Pipeline:
//   1. Your prompt goes to the local model. Always. No interception.
//   2. The local model works on the task. When it needs expert advice it
//      calls ask_advisor(query) with a specific, focused question.
//   3. The query is masked and dispatched as an ISOLATED completion call to
//      the cloud advisor (fresh two-message context, no tools, no history).
//   4. The advisor's response is captured, UNMASKED, and returned inline as
//      the tool result so the local model continues with the advice in hand.
//   5. The enabledByDefault gate controls whether the local model receives
//      a system-prompt nudge encouraging it to use ask_advisor. The tool
//      itself is always available regardless of the gate.
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

import { basename, dirname, join } from "node:path";
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
import { dispatchIsolatedAdvisor, splitSelector } from "./advisorDispatch.ts";
import { log, logPath } from "./logger.ts";

/**
 * Per-process config. Read once at extension load; a reload picks up edits.
 * `semanticTerms` are auto-registered as cipher terms for every session.
 */
interface OmniAdvisorConfig {
  enabledByDefault?: boolean;
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
  return f ? basename(f) : "unknown";
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
      "Consult a generalist software architect for initial task planning (rough overview without local files/code), architecture, performance, concurrency, security, and unfamiliar-framework questions. Do NOT use for routine syntax or locally verifiable work—work solo ($0). The query is masked (sensitive values become OMNI_* placeholders), sent to an isolated cloud advisor with no access to your files, tools, or conversation history, and the unmasked advice is returned.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          "The planning overview or technical dilemma. For initial planning, provide a high-level summary of the goal and expected volume without local code or files. For mid-task questions, name the language/framework/platform, the volume involved, and the specific hazard you want checked.",
        ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: ask_advisor requires a non-empty query." }],
          details: {},
        };
      }

      try {
        ensureConfigTerms(key);
        const masked = cipher.mask(query, key);
        log(
          key,
          "CLOUD_OUT",
          `ask_advisor query (masked, isolated dispatch): ${truncate(masked, 2000)}`,
        );

        const sel = advisorSelector();
        const result = await dispatchIsolatedAdvisor(sel, masked, config.advisorTimeoutMs, advisorFocus());

        if (!result.ok) {
          log(key, "ERROR", `advisor dispatch failed: ${result.error}`);
          return {
            content: [{ type: "text", text: `Error: cloud advisor unavailable — ${result.error}` }],
            details: {},
          };
        }

        log(key, "CLOUD_IN", `Advisor response (still masked): ${truncate(result.text!, 2000)}`);
        log(key, "UNMASK", `Advisor response restored to real values (${cipher.status(key).count} mappings active).`);
        const unmasked = cipher.unmask(result.text!, key);

        // Best-effort: keep the per-session quota display fresh after a cloud call.
        void refreshQuota(key);

        return {
          content: [{ type: "text", text: toolResponseFrame(unmasked) }],
          details: { advisor: sel },
        };
      } catch (err) {
        log(
          key,
          "ERROR",
          `ask_advisor failed: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`,
        );
        return {
          content: [{ type: "text", text: "Error: cloud advisor request failed (see debug.log)." }],
          details: {},
        };
      }
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
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isAdvisorEnabled(sessionKey(ctx))) return;
    return { systemPrompt: [...event.systemPrompt, executorNudge()] };
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
    const cost = usage.messageCost(usageInput);
    log(
      key,
      "MODEL_USAGE",
      `${model}: in=${u.input} out=${u.output} cacheR=${u.cacheRead} cacheW=${u.cacheWrite} $${(cost ?? 0).toFixed(4)}`,
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
      `session closed: in=${tot.input} out=${tot.output} cacheR=${tot.cacheRead} msgs=${tot.messages} total=$${(tot.costUsd ?? 0).toFixed(4)}`,
    );
    gateOnBySession.delete(key);
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
        { label: "on", value: "on", description: "Enable advisor nudge for this session" },
        { label: "off", value: "off", description: "Disable advisor nudge for this session" },
        { label: "status", value: "status", description: "Show gate state + resolved advisor model" },
        { label: "model", value: "model", description: "Select advisor model (model clear resets)" },
      ];
      const m = subs.filter((s) => s.label.startsWith(p));
      return m.length ? m : null;
    },
    handler: async (arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      const argNorm = (arg || "").trim().toLowerCase();
      const raw = (arg || "").trim();
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
        `omni-advisor: pipeline ${on ? "enabled" : "disabled"}; default=${def ? "enabled" : "disabled"}; advisor=${advisorSelector()} (isolated dispatch)`,
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
        ...st.entries.map((e) => `  ${e.placeholder}  ⇄  ${e.raw}  (${e.type})`),
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
        ctx.ui.notify("omni-usage: no usage recorded in this session yet.", "info");
        return;
      }
      const lines: string[] = [
        `omni-usage (${key}): ${sum.messages} assistant message(s)`,
        `  input=${sum.input}  output=${sum.output}  cacheRead=${sum.cacheRead}  cacheWrite=${sum.cacheWrite}`,
        `  total=$${(sum.costUsd ?? 0).toFixed(4)} (cost shown only where rate data exists; $0 = rateless/self-hosted)`,
        "",
        "  by model:",
        ...rows.map(
          (r) =>
            `    ${r.model}: in=${r.input} out=${r.output} cacheR=${r.cacheRead} cacheW=${r.cacheWrite} $${(r.costUsd ?? 0).toFixed(4)}`,
        ),
      ];
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
      usage.clearUsage(key);
      ctx.ui.notify("omni-cipher: mappings and usage cleared for this session.", "info");
    },
  });
}