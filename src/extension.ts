import { registerAdvisorCommand } from "./commands/advisorCommand.ts";
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
// Configuration: omni-advisor.config.json in the repository root
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
import {
  assertAbstract,
  validateBrief,
  PrivacyError,
} from "./privacy/planning.ts";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { readSettings, saveSettings } from "./state/settingsStorage.ts";
import { editProvider } from "./ui/settingsMenu.ts";
import {
  executionInstructions,
  abstractOnlyInstructions,
  type ExecutionMode,
} from "./workflow/executionMode.ts";
import { executorNudge, toolResponseFrame } from "./advisor/cloudAdvisor.ts";
import * as cipher from "./privacy/cipher.ts";
import * as usage from "./state/usageTracker.ts";
import {
  fetchGatewayModels,
  fetchGatewayUsage,
  formatLimitLines,
  loadProvider,
  type GatewayUsageReport,
} from "./advisor/gateway.ts";
import {
  dispatchIsolatedAdvisor,
  splitSelector,
  type ProviderConfig,
} from "./advisor/advisorDispatch.ts";
import {
  startAdvisorProgress,
  updateAdvisorFooter,
} from "./ui/advisorProgress.ts";
import { scopeInstructions } from "./workflow/executionScope.ts";
import { recoveryHint, type RecoveryMode } from "./workflow/recovery.ts";
import { SessionCoordinator } from "./state/sessionCoordinator.ts";
import { SessionMetrics } from "./state/sessionMetrics.ts";
import {
  PlanningGate,
  enforcedPlanningPrompt,
} from "./workflow/planningGate.ts";
import { dispatchOmpAdvisor } from "./advisor/ompAdvisor.ts";
import { log, logPath } from "./state/logger.ts";

/**
 * Per-process config. Read once at extension load; a reload picks up edits.
 * `semanticTerms` are auto-registered as cipher terms for every session.
 */
interface OmniAdvisorConfig {
  enabledByDefault?: boolean;
  enforcePlanning?: boolean;
  recoveryMode?: RecoveryMode;
  recoveryThreshold?: number;
  executionMode?: ExecutionMode;
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

const __dirname = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(__dirname, "omni-advisor.config.json");
/** Fallback advisor model when neither env nor config specifies one. */
const DEFAULT_ADVISOR_MODEL = "codex-lb/gpt-6.1-sol";

function loadConfig(): OmniAdvisorConfig {
  try {
    return readSettings(CONFIG_PATH) as OmniAdvisorConfig;
  } catch (error) {
    console.warn(`omni-advisor: Could not load configuration at ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

let config: OmniAdvisorConfig = loadConfig();

/** Resolved advisor model selector (provider/model). Override > env > config > default. */
function advisorSelector(): string {
  return (
    advisorModelOverride ||
    process.env.OMNI_ADVISOR_MODEL ||
    config.advisorModel ||
    DEFAULT_ADVISOR_MODEL
  );
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
  if (modelOptionsInFlight || (modelOptions && Date.now() - modelOptions.ts < 600000)) return;
  const sel = advisorSelector();
  const { provider } = splitSelector(sel);
  if (config.providers?.[provider]) return;
  const gw = loadProvider(provider);
  if (!gw) return;
  modelOptionsInFlight = true;
  void fetchGatewayModels(gw, 8000)
    .then((data) => {
      const items: AdvisorModelOption[] = data.map((m) => ({
        label: `${provider}/${m.id}`,
        description: m.description || m.displayName || m.id,
      }));
      items.unshift({ label: sel, description: "current advisor" });
      modelOptions = { ts: Date.now(), items };
    })
    .catch(() => {
      // Roster unavailable — static candidates only (see advisorModelOptions).
    })
    .finally(() => {
      modelOptionsInFlight = false;
    });
}

function advisorModelOptions(): AdvisorModelOption[] {
  refreshModelOptions();
  const roster = new Map<string, AdvisorModelOption>();
  for (const option of modelOptions?.items ?? []) {
    if (!roster.has(option.label)) roster.set(option.label, option);
  }
  const candidates = new Set([
    advisorSelector(),
    config.advisorModel,
    process.env.OMNI_ADVISOR_MODEL,
  ]);
  const defaults = [...candidates]
    .filter((label): label is string =>
      typeof label === "string" && label.includes("/") && !roster.has(label),
    )
    .map((label) => ({ label, description: "configured / fallback" }));
  return [...defaults, ...roster.values()];
}

/**
 * Effective advisor nudge gate for a session.
 *   explicit per-session override > config.enabledByDefault > false
 */
function isAdvisorEnabled(key: string): boolean {
  const explicit = gateOnBySession.get(key);
  return explicit === undefined ? config.enabledByDefault === true : explicit;
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
    .map(([raw, type]) => ({
      raw: raw.trim(),
      type: type as cipher.SemanticTermType,
    }))
    .filter((t) => t.raw.length > 0);
  if (terms.length === 0) return;
  const before = cipher.status(key).count;
  cipher.registerTerms(key, terms);
  const after = cipher.status(key).count;
  const registered = after - before;
  const skipped = terms.length - registered;
  log(
    key,
    "CIPHER_INIT",
    `Registered ${registered} config semantic terms for this session${skipped ? ` (${skipped} already known)` : ""}.`,
  );
}

/** Process-lifetime advisor model override set via /omni-advisor model. */
let advisorModelOverride: string | undefined;
function executionMode(key: string): ExecutionMode {
  return activeSessions.get(key)?.mode ?? config.executionMode ?? "balanced";
}
let sourceOverride: "config" | "omp" | undefined;
function advisorSource(): "config" | "omp" {
  return sourceOverride ?? config.advisorSource ?? "config";
}

/** Per-session advisor-nudge on/off state, persisted to
 *  logs/omni-advisor-gates.json so a session left "on" (or "off") keeps its
 *  state across omp restarts. */
const GATES_FILE = join(__dirname, "logs", "omni-advisor-gates.json");

function loadGates(): Map<string, boolean> {
  try {
    if (!existsSync(GATES_FILE)) return new Map();
    const data = JSON.parse(readFileSync(GATES_FILE, "utf8")) as Record<
      string,
      boolean
    >;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function persistGates(): void {
  try {
    mkdirSync(dirname(GATES_FILE), { recursive: true });
    writeFileSync(
      GATES_FILE,
      JSON.stringify(Object.fromEntries(gateOnBySession)),
    );
  } catch {
    // best effort
  }
}

const gateOnBySession = loadGates();
const planningGate = new PlanningGate();
function planningEnforced(key: string): boolean {
  return activeSessions.get(key)?.enforcePlanning ?? config.enforcePlanning === true;
}

interface ChecklistItem {
  id: string;
  requirement: string;
  status: string;
  evidence?: string;
}
interface ActiveSession {
  mode?: ExecutionMode;
  enforcePlanning?: boolean;
  checklist?: { items: ChecklistItem[]; revision: number };
  metrics: SessionMetrics;
}
// These settings and task data are discarded at shutdown. Dispatch counts are
// process-scoped per session key so resuming cannot reset the budget.
const activeSessions = new Map<string, ActiveSession>();
function activeSession(key: string): ActiveSession {
  let state = activeSessions.get(key);
  if (!state) {
    state = { metrics: new SessionMetrics() };
    activeSessions.set(key, state);
  }
  return state;
}
const consultationCounts = new Map<string, number>();
const pendingConsultations = new Set<string>();
const lastQuotaBySession = new Map<
  string,
  { ts: number; report: GatewayUsageReport }
>();

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
    log(
      "unknown",
      "ERROR",
      "sessionKey fallback: ctx.sessionManager.getSessionFile() unavailable; cipher bucketing degrades to shared 'unknown' key (terms persist across sessions) until omp restart",
    );
  }
  return f ? createHash("sha256").update(f).digest("hex") : "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max
    ? s.slice(0, max) + `…[truncated ${s.length - max} chars]`
    : s;
}

export default function omniAdvisor(pi: ExtensionAPI): void {
  const z = pi.zod;
  const advisorNotices = new Map<string, "queued" | "ready">();
  function setAdvisorEnabled(key: string, enabled: boolean): void {
    gateOnBySession.set(key, enabled);
    if (enabled) ensureConfigTerms(key);
    else advisorNotices.delete(key);
  }
  const sessions = new SessionCoordinator(
    sessionKey,
    typeof pi.appendEntry === "function"
      ? (type, data) => pi.appendEntry(type, data)
      : undefined,
  );
  const recoverySessions = sessions.recoverySessions;
  const recoveryKey = (ctx: { sessionManager: any }) =>
    sessions.recoveryKey(ctx);
  const recovery = (ctx: { sessionManager: any }) => sessions.recovery(ctx);
  const newRecoveryTask = (ctx: { sessionManager: any }) => {
    const key = sessionKey(ctx);
    recovery(ctx).newTask();
    delete activeSession(key).checklist;
    if (planningEnforced(key)) planningGate.begin(key);
  };
  const recoveryMode = (): RecoveryMode =>
    ["disabled", "observe", "enforce"].includes(config.recoveryMode ?? "")
      ? config.recoveryMode!
      : "observe";
  const recoveryThreshold = () =>
    Number.isInteger(config.recoveryThreshold) &&
    config.recoveryThreshold! >= 2 &&
    config.recoveryThreshold! <= 20
      ? config.recoveryThreshold!
      : 3;
  const restoreRecovery = async (
    _event: unknown,
    ctx: { sessionManager: any },
  ) => {
    sessions.restore(ctx);
  };
  pi.on("session_start", restoreRecovery);
  pi.on("session_switch", restoreRecovery);
  pi.on("session_tree", restoreRecovery);

  // ---------------------------------------------------------------------
  // Tool: ask_advisor — ISOLATED cloud-advisor dispatch
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "ask_advisor",
    label: "Ask Cloud Advisor",
    description:
      "Consult a generalist software architect for initial task planning (rough overview without local files/code), architecture, performance, concurrency, security, and unfamiliar-framework questions. Do NOT use for routine syntax or locally verifiable work—work solo ($0). Only abstract architecture, constraints, synthetic examples, and summarized outcomes are allowed. Never send source code, records, raw errors, logs, or proprietary business rules. Registered identifiers are masked as a secondary safeguard, sent to an isolated cloud advisor with no access to your files, tools, or conversation history, and advice retains placeholders. Call advisor_status for real extension settings; do not infer them from OMP cfg://advisor.",
    parameters: z.object({
      recoveryEpisode: z
        .string()
        .optional()
        .describe(
          "For one optional advisor consultation about an active recovery episode. Never includes raw failure evidence.",
        ),
      purpose: z
        .enum(["plan", "decision", "checkpoint", "review"])
        .optional()
        .describe(
          "Use plan for initial planning, decision for a consequential open choice, checkpoint to revalidate a plan, or review for a final abstract evidence check.",
        ),
      invariants: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "Abstract correctness/security properties that must remain true.",
        ),
      alternatives: z
        .string()
        .max(1500)
        .optional()
        .describe(
          "At most two abstract options and tradeoffs, without private implementation details.",
        ),
      outcomes: z
        .array(
          z.object({
            check: z.string().min(1).max(200),
            status: z.enum(["passed", "failed", "unverified"]),
            summary: z.string().min(1).max(500),
          }),
        )
        .max(8)
        .optional()
        .describe(
          "Summarized outcomes only; never raw test output, records, or logs.",
        ),
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
      // Pending recovery calls are linked even if the model omits the optional metadata.
      const recoveryEpisode =
        params.recoveryEpisode ??
        (recoveryMode() !== "disabled"
          ? recovery(ctx).pendingEpisodeId()
          : undefined);
      // Reserve once before every gate so rejection/unavailability cannot create an escalation loop.
      if (recoveryEpisode) {
        try {
          if (!recovery(ctx).advice(recoveryEpisode))
            return {
              content: [
                {
                  type: "text",
                  text: "Advice was already requested for this recovery episode. Record a local decision or blocker.",
                },
              ],
              details: { status: "recovery_advice_used" },
            };
          recoverySessions.save(recoveryKey(ctx));
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Unknown recovery episode. Use advisor_recovery to inspect current state.",
              },
            ],
            details: {},
          };
        }
      }
      const stats = activeSession(key).metrics;
      if (key === "unknown" || !isAdvisorEnabled(key)) {
        stats.blocked++;
        return {
          content: [
            {
              type: "text",
              text: "Cloud consultation blocked: enable /omni-advisor on and use an isolated session. Continue locally.",
            },
          ],
          details: { status: "disabled" },
        };
      }
      const limit = config.maxConsultationsPerSession;
      if (
        (limit !== undefined &&
          (!Number.isInteger(limit) ||
            limit < 1 ||
            (consultationCounts.get(key) ?? 0) >= limit)) ||
        pendingConsultations.has(key)
      ) {
        stats.blocked++;
        return {
          content: [
            {
              type: "text",
              text: "Consultation budget exhausted or another consultation is pending. Continue with the local plan.",
            },
          ],
          details: { status: "budget" },
        };
      }
      const planningToken = planningGate.token(key);
      pendingConsultations.add(key);
      try {
        const query = validateBrief(params);
        const focus = advisorFocus();
        if (focus) {
          assertAbstract(focus, "advisorFocus");
          if (focus.length > 1000)
            throw new PrivacyError("advisorFocus", "maximum 1000 characters");
        }
        ensureConfigTerms(key);
        const masked = cipher.mask(query, key);
        log(
          key,
          "CLOUD_OUT",
          `ask_advisor query (masked, isolated dispatch): ${masked.length} characters`,
        );

        const sel = advisorSelector();
        const mode = executionMode(key);
        const purpose = params.purpose ?? "plan";
        consultationCounts.set(key, (consultationCounts.get(key) ?? 0) + 1);
        const safeFocus = focus ? cipher.mask(focus, key) : undefined;
        assertAbstract(masked, "outbound brief");
        if (safeFocus) assertAbstract(safeFocus, "outbound focus");
        const dispatchStarted = Date.now();
        const progress = startAdvisorProgress((update) => {
          updateAdvisorFooter(ctx.ui, update);
          _onUpdate?.(update);
        }, _signal);
        let result;
        try {
          result =
            advisorSource() === "omp"
              ? await dispatchOmpAdvisor(
                  ctx.modelRegistry,
                  sel,
                  masked,
                  config.advisorTimeoutMs,
                  safeFocus,
                  _signal,
                  undefined,
                  progress.phase,
                  undefined,
                  mode,
                  purpose,
                )
              : await dispatchIsolatedAdvisor(
                  sel,
                  masked,
                  config.advisorTimeoutMs,
                  safeFocus,
                  config.providers,
                  _signal,
                  progress.phase,
                  mode,
                  purpose,
                );
          progress.stop(
            _signal?.aborted ? "cancelled" : result.ok ? "completed" : "failed",
          );
        } finally {
          progress.stop(_signal?.aborted ? "cancelled" : "failed");
        }

        stats.result(result.ok, Date.now() - dispatchStarted, result.usage);
        log(key, "METRICS", JSON.stringify(stats.snapshot()));
        if (!result.ok) {
          log(key, "ERROR", `advisor dispatch failed: ${result.error}`);
          return {
            content: [
              {
                type: "text",
                text: `Error: cloud advisor unavailable — ${result.error}`,
              },
            ],
            details: {},
          };
        }

        planningGate.complete(key, planningToken);
        log(
          key,
          "CLOUD_IN",
          `Advisor response: ${result.text!.length} characters`,
        );
        if (result.usage) usage.recordUsage(key, sel, result.usage);
        log(key, "PLAN", "Advisor plan received; placeholders retained.");
        // Keep placeholders unresolved: cloud output cannot select local secrets.
        const advice = result.text!;

        // Best-effort: keep the per-session quota display fresh after a cloud call.
        if (
          advisorSource() === "config" &&
          !config.providers?.[splitSelector(sel).provider]
        )
          void refreshQuota(key);

        return {
          content: [
            {
              type: "text",
              text: toolResponseFrame(advice, mode, purpose),
            },
          ],
          details: { advisor: sel },
        };
      } catch (err) {
        stats.blocked++;
        log(key, "ERROR", "ask_advisor validation or execution failed");
        return {
          content: [
            {
              type: "text",
              text:
                err instanceof PrivacyError
                  ? err.message
                  : "Consultation blocked by local validation. Check advisor_status and brief fields.",
            },
          ],
          details: {},
        };
      } finally {
        pendingConsultations.delete(key);
      }
    },
  });

  pi.registerTool({
    name: "advisor_recovery",
    label: "Recovery Decision (Local)",
    description:
      "Inspect bounded recovery state or authorize one exact local diagnostic/remedy with a short hypothesis and stopping condition. No cloud call required. No raw errors, private paths or source in explanatory fields. actionInput is local only. New tasks must be explicitly declared when scope is unrelated; continue/compaction do not reset recovery.",
    parameters: z.object({
      action: z.enum(["inspect", "decide", "blocked", "new-task"]).optional(),
      episode: z.string().optional(),
      reason: z.string().max(300).optional(),
      hypothesis: z.string().max(300).optional(),
      changed: z.string().max(300).optional(),
      nextAction: z.string().max(300).optional(),
      expectedEvidence: z.string().max(300).optional(),
      stopWhen: z.string().max(300).optional(),
      actionTool: z.enum(["bash", "eval", "edit", "write"]).optional(),
      actionInput: z.record(z.string(), z.unknown()).optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const controller = recovery(ctx),
        key = sessionKey(ctx);
      try {
        if (params.action === "new-task") {
          if (!params.reason || params.reason.length > 300)
            throw new Error(
              "Provide a short reason for an unrelated task transition.",
            );
          assertAbstract(params.reason, "task transition");
          newRecoveryTask(ctx);
        } else if (params.action === "blocked")
          controller.block(params.episode ?? "", params.reason ?? "");
        else if (params.action === "decide")
          controller.decide(params.episode ?? "", {
            hypothesis: params.hypothesis!,
            changed: params.changed!,
            nextAction: params.nextAction!,
            expectedEvidence: params.expectedEvidence!,
            stopWhen: params.stopWhen!,
            actionTool: params.actionTool!,
            actionInput: params.actionInput ?? {},
          });
        const saved = recoverySessions.save(recoveryKey(ctx));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                state: controller.summary(),
                persistence: saved
                  ? "saved"
                  : recoverySessions.persistence(recoveryKey(ctx)),
              }),
            },
          ],
          details: { recovery: controller.summary() },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text:
                err instanceof Error
                  ? err.message
                  : "Invalid recovery decision.",
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "advisor_checklist",
    label: "Local Plan Checklist",
    description:
      "Local only. Store or inspect a compact requirement-to-evidence checklist. Omit items to read. Before reporting completion reconcile every requirement; self-reported evidence is not independent verification. Never resend this local evidence to the cloud automatically.",
    parameters: z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(40),
            requirement: z.string().min(1).max(500),
            status: z.enum(["pending", "passed", "failed", "unverified"]),
            evidence: z.string().max(1000).optional(),
          }),
        )
        .max(50)
        .optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = activeSession(sessionKey(ctx));
      const revision = recovery(ctx).revision;
      if (params.items) {
        state.checklist = {
          revision,
          items: params.items.map((item) => ({
            ...item,
            status:
              item.status === "passed" && !item.evidence?.trim()
                ? "unverified"
                : item.status,
          })),
        };
      }
      const stale =
        state.checklist !== undefined && state.checklist.revision < revision;
      const items = (state.checklist?.items ?? []).map((item) =>
        stale && item.status === "passed"
          ? { ...item, status: "unverified", evidence: undefined }
          : item,
      );
      const summary = {
        items,
        complete:
          items.length > 0 && items.every((item) => item.status === "passed"),
        verification: stale
          ? "Observed edits since evidence was recorded; revalidate relevant checks. External changes cannot be tracked."
          : "local-model-reported; check evidence against actual results",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  });

  pi.registerTool({
    name: "advisor_status",
    label: "Advisor Status (Local)",
    description:
      "Read actual omni-advisor settings, planning state, provider configuration readiness, usage, and timing. Local only; no credential values, authentication refresh, or network calls. Configuration presence does not prove connectivity.",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const selector = advisorSelector();
      const { provider, model } = splitSelector(selector);
      const explicit = config.providers?.[provider];
      let readiness = "not configured";
      if (advisorSource() === "omp") {
        readiness = ctx.modelRegistry?.find(provider, model)
          ? "model registered; authentication and connectivity unverified"
          : "model unavailable";
      } else if (explicit) {
        readiness =
          explicit.apiKeyEnv && !process.env[explicit.apiKeyEnv]
            ? "required key environment variable missing"
            : "configuration present; connectivity unverified";
      } else if (loadProvider(provider))
        readiness = "legacy configuration present; connectivity unverified";
      const status = {
        enabled: isAdvisorEnabled(key),
        isolatedSession: key !== "unknown",
        source: advisorSource(),
        model: selector,
        authorization: recovery(ctx).scope,
        executionMode: executionMode(key),
        enforcedPlanning: planningEnforced(key),
        awaitingPlan: planningEnforced(key) && !planningGate.ready(key),
        pending: pendingConsultations.has(key),
        maxConsultationsPerSession: config.maxConsultationsPerSession ?? null,
        attemptedDispatches: consultationCounts.get(key) ?? 0,
        providerReadiness: readiness,
        recovery: {
          mode: recoveryMode(),
          threshold: recoveryThreshold(),
          persistence: recoverySessions.persistence(recoveryKey(ctx)),
          state: recovery(ctx).summary(),
        },
        advicePlaceholders: "retained",
        privacyPolicy:
          "abstract-only (heuristic validation; confidential meaning is not provably detected)",
        cipherStorage: "memory-only",
        measurements: activeSession(key).metrics.snapshot(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        details: status,
      };
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
          term: z
            .string()
            .describe(
              "The exact real value to mask (e.g. 'acme-corp' or 'build-host-01').",
            ),
          type: z
            .enum(["WORKSPACE", "HOST", "PERSON_OR_ORG", "SECRET", "OTHER"])
            .describe("Semantic category used for the OMNI_* placeholder."),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const terms = params.terms
        .map((t) => ({
          raw: t.term.trim(),
          type: t.type as cipher.SemanticTermType,
        }))
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
    if (event.source !== "extension") {
      sessions.input(ctx, event.text ?? "");
    }
  });
  pi.on("session_compact", async (_event, ctx) => {
    sessions.compact(ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const key = sessionKey(ctx);
    // Wait for a new prompt instead of adding the notice to an in-flight turn.
    if (event.reason !== "revive" && advisorNotices.get(key) === "queued") {
      advisorNotices.set(key, "ready");
    }
    const state = activeSession(key);
    state.metrics.begin();
    const enforced = planningEnforced(key);
    if (sessions.beginsTask(ctx, event.reason)) {
      delete state.checklist;
      if (enforced) planningGate.begin(key);
    }
    if (
      !isAdvisorEnabled(key) &&
      !enforced &&
      recoveryMode() === "disabled" &&
      recovery(ctx).scope === "active"
    )
      return;
    const recoveryHandoff =
      recoveryMode() === "disabled"
        ? []
        : recovery(ctx)
            .summary()
            .episodes.filter((e) => ["required", "blocked"].includes(e.phase))
            .slice(-2)
            .map((e) => ({
              episode: e.id,
              category: e.category,
              attempts: e.attempts,
              phase: e.phase,
              nextAction: e.decision?.nextAction,
              stopWhen: e.decision?.stopWhen,
            }));
    const advisorPrompts = isAdvisorEnabled(key)
      ? [executorNudge(), abstractOnlyInstructions]
      : [
          "Cloud access is OFF. Recover locally with advisor_recovery or report a blocker; do not attempt advisor calls or enable cloud access yourself.",
          abstractOnlyInstructions,
        ];
    return {
      systemPrompt: [
        ...event.systemPrompt,
        scopeInstructions({ scope: recovery(ctx).scope }),
        ...advisorPrompts,
        ...(recoveryHandoff.length
          ? [
              `Pending recovery: ${JSON.stringify(recoveryHandoff)}. Use advisor_recovery for full evidence; this is local state, never upload it automatically.`,
            ]
          : []),
        ...(isAdvisorEnabled(key) && executionMode(key) !== "local-led"
          ? [executionInstructions(executionMode(key))]
          : []),
        ...(enforced
          ? [
              enforcedPlanningPrompt,
              ...(planningGate.ready(key)
                ? [
                    "A successful cloud plan is already approved for the current task. Continue local execution from the retained plan/checklist; compaction does not require another consultation.",
                  ]
                : []),
            ]
          : []),
      ],
    };
  });

  pi.on("context", (event, ctx) => {
    if (advisorNotices.size === 0) return;
    const key = sessionKey(ctx);
    if (advisorNotices.get(key) !== "ready") return;
    advisorNotices.delete(key);
    // Add a user-role message to this request without recording a new turn.
    return {
      messages: [
        ...event.messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Friendly reminder: Cloud advisor access is now enabled for this session. This is a status update only. The configured workflow and current task scope still govern consultations.",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const key = sessionKey(ctx);
    const restricted = recovery(ctx).scopeRestriction(
      event.toolName,
      event.input ?? {},
    );
    if (restricted) return { block: true, reason: restricted };
    if (planningEnforced(key) && planningGate.blocked(key, event.toolName)) {
      return {
        block: true,
        reason:
          "Execution blocked by enforced planning. Use read/grep/glob/ls/find to gather local facts, then call ask_advisor with an abstract brief. A successful consultation unlocks execution for this prompt. If cloud access or budget is unavailable, report the blocker; the user can use /omni-advisor planning off.",
      };
    }
    if (recoveryMode() !== "disabled") {
      const blocked = recovery(ctx).start(
        event.toolCallId,
        event.toolName,
        event.input ?? {},
        recoveryMode() === "enforce",
      );
      recoverySessions.save(recoveryKey(ctx));
      if (blocked)
        return {
          block: true,
          reason: `Repeated operation requires a recovery decision (episode ${blocked}). ${recoveryHint}`,
        };
    }
    activeSession(key).metrics.toolStart(event.toolCallId);
  });
  pi.on("tool_result", async (event, ctx) => {
    const key = sessionKey(ctx);
    activeSession(key).metrics.toolEnd(event.toolCallId);
    if (recoveryMode() !== "disabled") {
      const episode = recovery(ctx).observe(
        event.toolCallId,
        event.toolName,
        event.input ?? {},
        event,
        recoveryThreshold(),
      );
      recoverySessions.save(recoveryKey(ctx));
      if (episode)
        return {
          content: [
            ...event.content,
            {
              type: "text",
              text: `Recovery episode ${episode.id} (${episode.category}, ${episode.attempts} similar unsuccessful attempts). ${recoveryHint}`,
            },
          ],
        };
    }
  });
  pi.on("agent_end", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const metrics = activeSession(key).metrics;
    metrics.end();
    log(key, "METRICS", JSON.stringify(metrics.snapshot()));
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
    const model =
      msg.provider && msg.model
        ? `${msg.provider}/${msg.model}`
        : msg.model || "unknown";
    const usageInput = {
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheWrite: u.cacheWrite || 0,
    };
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
    try {
      ctx.ui?.setStatus?.("omni-advisor", undefined);
    } catch {
      /* optional UI */
    }
    cipher.forgetSession(key);
    configTermsEnsuredFor.delete(key);
    gateOnBySession.delete(key);
    advisorNotices.delete(key);
    planningGate.clear(key);
    activeSessions.delete(key);
    sessions.forget(ctx);
  });

  // ---------------------------------------------------------------------
  // Command: /omni-advisor on | off | status | model [provider/model]
  // ---------------------------------------------------------------------
  registerAdvisorCommand(pi, (ctx) => {
    const key = sessionKey(ctx);
    return {
      state: () => ({
        enabled: isAdvisorEnabled(key),
        enforced: planningEnforced(key),
        mode: executionMode(key),
        source: advisorSource(),
        model: advisorSelector(),
        recoveryMode: recoveryMode(),
        recoveryThreshold: recoveryThreshold(),
        authorization: recovery(ctx).scope,
        limit: config.maxConsultationsPerSession,
        timeout: config.advisorTimeoutMs ?? 120000,
      }),
      setCloudAccess(enabled) {
        setAdvisorEnabled(key, enabled);
        const noticeQueued = enabled && key !== "unknown";
        if (noticeQueued && !advisorNotices.has(key)) {
          advisorNotices.set(key, "queued");
        }
        persistGates();
        return noticeQueued;
      },
      defaultsEnabled: () => config.enabledByDefault === true,
      recordModel: (model: string) =>
        log(
          key,
          "ADVISOR_MODEL",
          `advisor model override set to ${model} (process lifetime; /omni-advisor model clear resets)`,
        ),
      clearModel: () => {
        advisorModelOverride = undefined;
      },
      modelOverride: () => advisorModelOverride,
      recovery: () => recovery(ctx),
      saveRecovery: () => {
        recoverySessions.save(recoveryKey(ctx));
      },
      newTask: () => newRecoveryTask(ctx),
      change(patch) {
        if (patch.enabled !== undefined) setAdvisorEnabled(key, patch.enabled);
        if (patch.enforced !== undefined) {
          activeSession(key).enforcePlanning = patch.enforced;
          if (patch.enforced) planningGate.begin(key);
          else planningGate.clear(key);
        }
        if (patch.authorization) {
          recovery(ctx).setScope(patch.authorization);
          recoverySessions.save(recoveryKey(ctx));
        }
        if (patch.recoveryMode) config.recoveryMode = patch.recoveryMode;
        if (patch.recoveryThreshold !== undefined)
          config.recoveryThreshold = patch.recoveryThreshold;
        if (patch.mode) activeSession(key).mode = patch.mode;
        if (patch.source) sourceOverride = patch.source;
        if (patch.model) advisorModelOverride = patch.model;
        if ("limit" in patch) config.maxConsultationsPerSession = patch.limit;
        if (patch.timeout !== undefined)
          config.advisorTimeoutMs = patch.timeout;
      },
      ompModels: () => [
        ...new Set(
          ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
        ),
      ],
      async provider() {
        const result = await editProvider(
          ctx.ui,
          config.providers ?? {},
          splitSelector(advisorSelector()).provider,
        );
        if (result)
          config.providers = {
            ...config.providers,
            [result.alias]: result.provider,
          };
      },
      save() {
        saveSettings(CONFIG_PATH, {
          enabledByDefault: isAdvisorEnabled(key),
          enforcePlanning: planningEnforced(key),
          executionMode: executionMode(key),
          advisorSource: advisorSource(),
          advisorModel: advisorSelector(),
          advisorTimeoutMs: config.advisorTimeoutMs ?? 120000,
          maxConsultationsPerSession: config.maxConsultationsPerSession,
          recoveryMode: recoveryMode(),
          recoveryThreshold: recoveryThreshold(),
          providers: config.providers,
        });
        config = loadConfig();
        persistGates();
      },
    };
  }, advisorModelOptions);

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
        ctx.ui.notify(
          `omni-usage: no token usage recorded. Consultation/timing: ${JSON.stringify(activeSession(key).metrics.snapshot())}`,
          "info",
        );
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
      lines.push(
        "",
        `  consultations/timing: ${JSON.stringify(activeSession(key).metrics.snapshot())}`,
      );
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
    description:
      "omni-advisor: clear cipher mappings and usage for this session",
    handler: async (_arg: string, ctx: ExtensionCommandContext) => {
      const key = sessionKey(ctx);
      cipher.clearSession(key);
      configTermsEnsuredFor.delete(key);
      usage.clearUsage(key);
      ctx.ui.notify(
        "omni-cipher: mappings and usage cleared for this session.",
        "info",
      );
    },
  });
}
