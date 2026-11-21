import { randomUUID } from "node:crypto";
import { assertAbstract } from "../privacy/planning.ts";
import type { ExecutionScope } from "./executionScope.ts";

const kinds = ["inspect", "edit", "shell", "finish"] as const;
type StepKind = (typeof kinds)[number];

interface StepProposal {
  kind: StepKind;
  objective: string;
  constraints: string;
  successCheck: string;
}
interface ApprovedStep extends StepProposal {
  id: string;
}

/** Accept exactly one bounded proposal. Tool names, arguments and actions are chosen locally. */
export function parseCloudLedProposal(response: string): StepProposal | undefined {
  const text = response.trim();
  if (text.length > 4000) return;
  const json = text.match(/^```(?:json)?\s*\n([\s\S]+)\n```$/i)?.[1] ?? text;
  try {
    const proposal = JSON.parse(json) as Partial<StepProposal> | null;
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) ||
        Object.keys(proposal).length !== 4 || !kinds.includes(proposal.kind!)) return;
    const { kind, objective, constraints, successCheck } = proposal;
    for (const field of [objective, constraints, successCheck]) {
      if (typeof field !== "string" || field.length > 800) return;
      assertAbstract(field);
    }
    return { kind: kind!, objective: objective!, constraints: constraints!, successCheck: successCheck! };
  } catch {
    return undefined;
  }
}

export function cloudLedScopeAllows(kind: StepKind, scope: ExecutionScope): boolean {
  return scope === "active" || (scope !== "paused" && (kind === "inspect" || kind === "finish"));
}

const coordinationTools = new Set([
  "ask_advisor", "advisor_status", "advisor_checklist", "advisor_recovery", "register_masked_terms",
]);
const readTools = new Set(["read", "grep", "glob", "ls", "find"]);

/** One local approval and its outstanding tool calls. Approvals are never restored from a receipt. */
export class CloudLedWorkflow {
  private active?: ApprovedStep;
  private lastReportedStepId?: string;
  private readonly runningTools = new Set<string>();
  private backgroundedShell = false;

  consultationBlock(stepId: string | undefined, outcomes: readonly { status: string }[]): string | undefined {
    if (this.backgroundedShell) return "OMP backgrounded a shell command. Wait for it to settle and start a fresh user turn before requesting another step.";
    if (this.runningTools.size) return "Wait for the active cloud-led step's tools to finish before reporting it.";
    const expectedId = this.active?.id ?? this.lastReportedStepId;
    if (expectedId && (stepId !== expectedId || outcomes.length === 0)) {
      return "Report the current or last reported cloud-led step with its cloudStepId and at least one abstract outcome. Use advisor_status to recover the step ID.";
    }
    if (!expectedId && stepId) return "There is no matching cloud-led step to report. Request a fresh step without cloudStepId.";
    if (this.active?.kind === "finish" && outcomes.every((outcome) => outcome?.status === "passed")) {
      return "The advisor proposed finishing. Report completion if the evidence supports it, or report a failed or unverified check before requesting a revision.";
    }
  }

  report(): ApprovedStep | undefined {
    const step = this.active;
    if (!step) return;
    this.lastReportedStepId = step.id;
    this.active = undefined;
    return step;
  }

  approve(proposal: StepProposal): ApprovedStep {
    this.active = { id: randomUUID(), ...proposal };
    this.lastReportedStepId = undefined;
    return this.active;
  }

  toolBlock(tool: string, scope: ExecutionScope, input: Record<string, unknown>): string | undefined {
    if (coordinationTools.has(tool)) return;
    if (this.backgroundedShell) return "A shell command was backgrounded by OMP. Wait for it to settle before starting fresh work.";
    const step = this.active;
    if (!step) return "Cloud-led work is waiting for one approved step. Call ask_advisor or report the blocker.";
    if (!cloudLedScopeAllows(step.kind, scope)) return "The active cloud-led step is outside the user's current scope.";
    if (step.kind !== "finish" && readTools.has(tool)) return;
    if (step.kind === "edit" && (tool === "edit" || tool === "write")) return;
    if (step.kind === "shell" && tool === "bash") {
      if (input.async === true || input.name || input.ready) return "Cloud-led shell steps use foreground commands only.";
      return;
    }
    return `This tool is outside the active cloud-led ${step.kind} step. Report the step's abstract outcome before requesting a different step.`;
  }

  toolStarted(tool: string, id: string): void {
    if (this.active && !coordinationTools.has(tool)) this.runningTools.add(id);
  }

  toolFinished(id: string, backgrounded: boolean): void {
    if (this.runningTools.delete(id) && backgrounded) this.backgroundedShell = true;
  }

  snapshot() {
    return {
      activeStep: this.active ? { ...this.active } : null,
      lastReportedStepId: this.lastReportedStepId ?? null,
      pendingTools: this.runningTools.size,
      backgroundedShell: this.backgroundedShell,
    };
  }
}
