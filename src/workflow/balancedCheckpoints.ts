import type { ConsultationPurpose } from "../privacy/planning.ts";
import type { ExecutionMode } from "./executionMode.ts";

type TrackedPurpose = Exclude<ConsultationPurpose, "checkpoint">;
type Outcome = "completed" | "blocked" | "stale";

export const balancedReviewReminder =
  "Balanced-mode reminder: this turn changed files and has no completed advisor review. If a final review is appropriate for the user's current task, call ask_advisor once with purpose review and an abstract summary of acceptance results. Keep files, raw output, and private details local. If you can finish within scope without a review or one is unavailable, report the limitation and finish. The current scope and verification requirements still apply.";

export type ReviewBlocker =
  | "cloud-off"
  | "different-workflow"
  | "user-scope"
  | "tool-inactive"
  | "budget-exhausted"
  | "consultation-pending";

interface TurnSettings {
  cloudEnabled: boolean;
  mode: ExecutionMode | "unknown";
  planningEnforced: boolean;
}

/** Metadata for the current turn, shared by its immediate compaction continuation. */
export class BalancedCheckpoints {
  substantiveWork = false;
  reviewReminderSent = false;
  settled = false;
  private outcomes: Partial<Record<TrackedPurpose, Outcome>> = {};
  private readonly startedWith: TurnSettings;

  constructor(settings: TurnSettings) {
    this.startedWith = settings;
  }

  observeEdit(): void {
    if (this.settled) return;
    this.substantiveWork = true;
    if (this.outcomes.review === "completed") this.outcomes.review = "stale";
  }

  record(purpose: ConsultationPurpose, outcome: Outcome): void {
    if (this.settled || (purpose !== "plan" && purpose !== "decision" && purpose !== "review")) return;
    if (this.outcomes[purpose] !== "completed") this.outcomes[purpose] = outcome;
  }

  snapshot(reviewBlocker?: ReviewBlocker) {
    const workRequiresAdvice = this.substantiveWork && reviewBlocker !== "different-workflow";
    const outstanding = workRequiresAdvice ? (reviewBlocker ? "blocked" : "due") : "not-due";
    const review = this.outcomes.review ?? outstanding;
    return {
      startedWith: { ...this.startedWith },
      substantiveWork: this.substantiveWork,
      plan: this.outcomes.plan ?? outstanding,
      decision: this.outcomes.decision ?? "optional",
      review,
      reviewReminderSent: this.reviewReminderSent,
      ...((review === "blocked" || review === "stale") && reviewBlocker ? { reviewBlocker } : {}),
    };
  }

  markReviewReminder(): boolean {
    if (this.settled || !this.substantiveWork || this.reviewReminderSent ||
        (this.outcomes.review && this.outcomes.review !== "stale")) return false;
    this.reviewReminderSent = true;
    return true;
  }
}
