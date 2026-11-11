import { logicalChecks } from "./logicalChecks.ts";
import { userScope, scopeBlock, type ScopeState } from "./executionScope.ts";
import { createHash, randomUUID } from "node:crypto";
import { assertAbstract } from "../privacy/planning.ts";
import {
  classify,
  operationKey,
  normalizeDiagnostic,
  legacyShellKey,
  type FailureCategory,
  type Outcome,
} from "./recoveryEvidence.ts";
export {
  classify,
  operationKey,
  normalizeDiagnostic,
  type Observation,
  type FailureCategory,
} from "./recoveryEvidence.ts";
export type RecoveryMode = "disabled" | "observe" | "enforce";
export const RECOVERY_ENTRY = "omni-advisor.recovery.v1";
const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);
const digest = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{24}$/.test(s);

export interface RecoveryDecision {
  hypothesis: string;
  changed: string;
  nextAction: string;
  expectedEvidence: string;
  stopWhen: string;
  actionTool: "bash" | "eval" | "edit" | "write";
  actionInput: Record<string, unknown>;
}
interface Episode {
  id: string;
  operation: string;
  signature: string;
  category: FailureCategory;
  attempts: number;
  phase:
    | "suspected"
    | "required"
    | "authorized"
    | "resolved"
    | "retired"
    | "blocked";
  outcomes: Outcome[];
  evidenceRevision: number;
  compound: boolean;
  adviceRequested: boolean;
  decisions: Array<{ hypothesis: string; remedy: string; revision: number }>;
  decision?: {
    hypothesis: string;
    changed: string;
    nextAction: string;
    expectedEvidence: string;
    stopWhen: string;
  };
  authorizedOperation?: string;
  overrideReason?: string;
  logicalStall?: boolean;
}
export interface RecoveryState extends ScopeState {
  version: 1;
  taskId: string;
  revision: number;
  episodes: Episode[];
}
export class RecoveryController {
  private state: RecoveryState = {
    version: 1,
    taskId: randomUUID(),
    revision: 0,
    episodes: [],
  };
  private activeCalls = new Map<string, string>();
  private callTasks = new Map<string, string>();
  private blockedCalls = new Set<string>();
  snapshot(): RecoveryState {
    return structuredClone(this.state);
  }
  // Only controller-produced, bounded schema is restored. Arbitrary session text is never executed.
  restore(raw: unknown): boolean {
    try {
      if (JSON.stringify(raw).length > 32000) return false;
      const s = raw as RecoveryState;
      if (
        s.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(s.taskId) ||
        !Number.isSafeInteger(s.revision) ||
        s.revision < 0 ||
        !Array.isArray(s.episodes) ||
        s.episodes.length > 8
      )
        return false;
      if (
        s.scope !== undefined &&
        !["active", "paused", "analysis", "closure"].includes(s.scope)
      )
        return false;
      if (
        s.resumeScope !== undefined &&
        !["active", "paused", "analysis", "closure"].includes(s.resumeScope)
      )
        return false;
      if (
        s.cleanupAllowed !== undefined &&
        typeof s.cleanupAllowed !== "boolean"
      )
        return false;
      const categories = [
        "transport",
        "environment",
        "edit-syntax",
        "assertion",
        "setup",
        "command",
      ];
      for (const e of s.episodes) {
        if (
          !digest(e.id) ||
          !digest(e.operation) ||
          !digest(e.signature) ||
          !categories.includes(e.category) ||
          ![
            "suspected",
            "required",
            "authorized",
            "resolved",
            "retired",
            "blocked",
          ].includes(e.phase) ||
          !Number.isSafeInteger(e.attempts) ||
          e.attempts < 1 ||
          e.attempts > 10000 ||
          !Number.isSafeInteger(e.evidenceRevision) ||
          e.evidenceRevision < 0 ||
          typeof e.adviceRequested !== "boolean" ||
          typeof e.compound !== "boolean" ||
          (e.authorizedOperation !== undefined &&
            !digest(e.authorizedOperation))
        )
          return false;
        if (
          !Array.isArray(e.outcomes) ||
          e.outcomes.length > 6 ||
          e.outcomes.some(
            (o) =>
              !["passed", "failed", "skipped", "unrun", "unknown"].includes(o),
          ) ||
          !Array.isArray(e.decisions) ||
          e.decisions.length > 4
        )
          return false;
        for (const d of e.decisions)
          if (
            !digest(d.hypothesis) ||
            !digest(d.remedy) ||
            !Number.isSafeInteger(d.revision)
          )
            return false;
        if (e.logicalStall !== undefined && typeof e.logicalStall !== "boolean")
          return false;
        if (e.decision)
          for (const k of [
            "hypothesis",
            "changed",
            "nextAction",
            "expectedEvidence",
            "stopWhen",
          ] as const)
            this.safe(e.decision[k]);
        if (e.overrideReason !== undefined) this.safe(e.overrideReason);
      }
      // Rebuild the allowlisted structure; do not preserve unknown sensitive fields.
      this.state = {
        version: 1,
        taskId: s.taskId,
        revision: s.revision,
        scope: s.scope,
        resumeScope: s.resumeScope,
        cleanupAllowed: s.cleanupAllowed,
        episodes: s.episodes.map((e) => ({
          id: e.id,
          logicalStall: e.logicalStall,
          operation: e.operation,
          signature: e.signature,
          category: e.category,
          attempts: e.attempts,
          phase: e.phase,
          outcomes: [...e.outcomes],
          evidenceRevision: e.evidenceRevision,
          compound: e.compound,
          adviceRequested: e.adviceRequested,
          decisions: e.decisions.map((d) => ({
            hypothesis: d.hypothesis,
            remedy: d.remedy,
            revision: d.revision,
          })),
          ...(e.decision
            ? {
                decision: {
                  hypothesis: e.decision.hypothesis,
                  changed: e.decision.changed,
                  nextAction: e.decision.nextAction,
                  expectedEvidence: e.decision.expectedEvidence,
                  stopWhen: e.decision.stopWhen,
                },
              }
            : {}),
          ...(e.authorizedOperation
            ? { authorizedOperation: e.authorizedOperation }
            : {}),
          ...(e.overrideReason ? { overrideReason: e.overrideReason } : {}),
        })),
      };
      // Never replay an in-flight authorization after a crash/reload.
      for (const e of this.state.episodes)
        if (e.phase === "authorized") {
          e.phase = "required";
          delete e.authorizedOperation;
        }
      return true;
    } catch {
      return false;
    }
  }
  newTask(): void {
    this.state = {
      version: 1,
      taskId: randomUUID(),
      revision: 0,
      episodes: [],
      scope: this.state.scope,
      resumeScope: this.state.resumeScope,
      cleanupAllowed: this.state.cleanupAllowed,
    };
    this.activeCalls.clear();
  }
  userInput(text: string): void {
    const scope = userScope(this.state, text);
    this.state.scope = scope.scope;
    this.state.resumeScope = scope.resumeScope;
    this.state.cleanupAllowed = scope.cleanupAllowed;
  }
  setScope(scope: NonNullable<ScopeState["scope"]>): void {
    if (scope === "paused" && this.state.scope !== "paused")
      this.state.resumeScope = this.state.scope ?? "active";
    this.state.scope = scope;
    this.state.cleanupAllowed = false;
  }
  scopeRestriction(
    tool: string,
    input: Record<string, unknown>,
  ): string | undefined {
    return scopeBlock(this.state, tool, input);
  }
  private safe(value: unknown): string {
    if (typeof value !== "string" || value.length > 300)
      throw new Error(
        "Use short abstract recovery fields (maximum 300 characters), no raw diagnostics or private values.",
      );
    assertAbstract(value, "recovery decision");
    return value;
  }
  private episode(id: string): Episode {
    const e = this.state.episodes.find((e) => e.id === id);
    if (!e) throw new Error("Recovery episode is no longer active.");
    return e;
  }
  decide(id: string, d: RecoveryDecision): void {
    const e = this.episode(id);
    if (!["required", "blocked"].includes(e.phase))
      throw new Error("This episode does not need another decision.");
    const decision = {
      hypothesis: this.safe(d.hypothesis),
      changed: this.safe(d.changed),
      nextAction: this.safe(d.nextAction),
      expectedEvidence: this.safe(d.expectedEvidence),
      stopWhen: this.safe(d.stopWhen),
    };
    const op = operationKey(d.actionTool, d.actionInput);
    if (!op) throw new Error("Specify one exact supported recovery action.");
    const hypothesis = hash(normalizeDiagnostic(decision.hypothesis)),
      remedy = op;
    if (
      e.decisions.some(
        (old) => old.remedy === remedy && old.revision === this.state.revision,
      )
    )
      throw new Error(
        "This hypothesis/action was already attempted without an observed edit or distinguishing evidence. Choose a different diagnostic/remedy or report a blocker.",
      );
    e.decision = decision;
    e.decisions.push({ hypothesis, remedy, revision: this.state.revision });
    e.decisions = e.decisions.slice(-4);
    e.phase = "authorized";
    e.authorizedOperation = op;
  }
  override(id: string, reason: string): void {
    const e = this.episode(id);
    e.overrideReason = this.safe(reason);
    e.phase = "authorized";
    e.authorizedOperation = e.operation;
  }
  block(id: string, reason: string): void {
    const e = this.episode(id);
    e.decision = {
      hypothesis: "External prerequisite unavailable",
      changed: this.safe(reason),
      nextAction: "Report blocker",
      expectedEvidence: "Prerequisite becomes available",
      stopWhen: "Do not retry until prerequisite changes",
    };
    e.phase = "blocked";
  }
  advice(id: string): boolean {
    const e = this.episode(id);
    if (e.adviceRequested) return false;
    e.adviceRequested = true;
    return true;
  }
  start(
    callId: string,
    tool: string,
    input: Record<string, unknown>,
    enforce: boolean,
  ): string | undefined {
    const op = operationKey(tool, input);
    if (!op) return;
    const candidates =
      tool === "bash"
        ? logicalChecks(input.command, input.cwd).map((c) => c.key)
        : [];
    // Prior v1 snapshots used the full cosmetic-normalized shell command as identity.
    const legacy = tool === "bash" ? legacyShellKey(input) : undefined;
    if (legacy) candidates.push(legacy);
    const locked = this.state.episodes.find(
      (e) =>
        (e.operation === op || candidates.includes(e.operation)) &&
        ["required", "blocked"].includes(e.phase),
    );
    if (enforce && locked) {
      this.blockedCalls.add(callId);
      if (this.blockedCalls.size > 64)
        this.blockedCalls.delete(this.blockedCalls.values().next().value!);
      return locked.id;
    }
    this.blockedCalls.delete(callId);
    this.callTasks.set(callId, this.state.taskId);
    if (this.callTasks.size > 64)
      this.callTasks.delete(this.callTasks.keys().next().value!);
    const authorized = this.state.episodes.find(
      (e) => e.phase === "authorized" && e.authorizedOperation === op,
    );
    if (authorized) {
      authorized.phase = "required";
      delete authorized.authorizedOperation;
      this.activeCalls.set(callId, authorized.id);
      if (this.activeCalls.size > 32)
        this.activeCalls.delete(this.activeCalls.keys().next().value!);
    }
    return;
  }
  observe(
    callId: string,
    tool: string,
    input: Record<string, unknown>,
    result: { isError?: boolean; content?: any[]; details?: any },
    threshold = 3,
  ): Episode | undefined {
    const startedTask = this.callTasks.get(callId);
    this.callTasks.delete(callId);
    if (
      this.blockedCalls.delete(callId) ||
      (startedTask && startedTask !== this.state.taskId)
    )
      return;
    const observation = classify(tool, input, result);
    if (!observation) return;
    const legacy = tool === "bash" ? legacyShellKey(input) : undefined;
    if (legacy && legacy !== observation.operation)
      for (const e of this.state.episodes)
        if (e.operation === legacy) {
          e.operation = observation.operation;
          e.logicalStall = true;
        }
    const active = this.activeCalls.get(callId);
    this.activeCalls.delete(callId);
    const unsuccessful =
      observation.outcome === "failed" || observation.outcome === "unrun";
    if (
      observation.outcome === "passed" &&
      (tool === "edit" || tool === "write")
    )
      this.state.revision++;
    // A diagnostic does not resolve the original check; its next retry needs another decision.
    if (active && !unsuccessful) {
      const e = this.episode(active);
      e.phase =
        observation.operation === e.operation &&
        observation.outcome === "passed"
          ? "resolved"
          : "required";
      if (observation.operation !== e.operation) {
        e.outcomes.push(observation.outcome);
        e.outcomes = e.outcomes.slice(-6);
      }
    }
    if (!unsuccessful) {
      const matched = this.state.episodes
        .slice()
        .reverse()
        .find(
          (e) => e.operation === observation.operation && e.phase !== "retired",
        );
      if (matched) {
        matched.outcomes.push(observation.outcome);
        matched.outcomes = matched.outcomes.slice(-6);
        if (observation.outcome === "passed") {
          for (const item of this.state.episodes)
            if (
              item.operation === observation.operation &&
              item.phase !== "retired"
            ) {
              item.phase = "resolved";
              item.evidenceRevision = this.state.revision;
            }
        }
      }
      return;
    }
    const logical =
      tool === "bash" && logicalChecks(input.command, input.cwd).length === 1;
    for (const prior of this.state.episodes) {
      if (
        prior.operation !== observation.operation ||
        ["resolved", "retired"].includes(prior.phase)
      )
        continue;
      if (
        logical
          ? prior.evidenceRevision !== this.state.revision
          : prior.signature !== observation.signature
      )
        prior.phase = "retired";
    }
    let e = this.state.episodes.find(
      (e) =>
        e.operation === observation.operation &&
        (logical
          ? e.logicalStall && e.evidenceRevision === this.state.revision
          : e.signature === observation.signature) &&
        !["resolved", "retired"].includes(e.phase),
    );
    if (!e) {
      e = {
        id: hash(randomUUID()),
        operation: observation.operation,
        signature: observation.signature,
        category: observation.category,
        attempts: 0,
        phase: "suspected",
        logicalStall: logical,
        outcomes: [],
        evidenceRevision: this.state.revision,
        compound: observation.compound,
        adviceRequested: false,
        decisions: [],
      };
      this.state.episodes.push(e);
      this.state.episodes = this.state.episodes.slice(-8);
    }
    if (logical) {
      e.signature = observation.signature;
      e.category = observation.category;
    }
    e.attempts = Math.min(10000, e.attempts + 1);
    e.outcomes.push(observation.outcome);
    e.outcomes = e.outcomes.slice(-6);
    if (e.attempts >= threshold) {
      const notify = e.phase === "suspected";
      e.phase = "required";
      return notify ? e : undefined;
    }
  }
  summary() {
    return {
      ...this.snapshot(),
      episodes: this.state.episodes.map((e) => ({
        ...e,
        evidenceFresh: e.evidenceRevision === this.state.revision,
        revisionScope:
          "observed successful edits/writes only; external changes unknown",
      })),
    };
  }
}
export const recoveryHint = `Recovery decision required before another equivalent retry. Use advisor_recovery to inspect the episode and record ONE short hypothesis, what changed, next action, expected distinguishing evidence, and stopping condition. Prefer a targeted diagnostic or materially different remedy; report a blocker if prerequisites are unavailable. Cloud is optional: if allowed, use ask_advisor with recoveryEpisode and an abstract brief asking whether to continue, simplify verification, or stop. Never upload raw diagnostics, code, paths, or session history. Advice cannot expand scope or weaken assertions. Preserve required final gates; do not stop testing solely because a counter fired.`;
