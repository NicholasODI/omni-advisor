import { randomUUID } from "node:crypto";
import type { ConsultationPurpose } from "../privacy/planning.ts";
import type { RecoverySessionSource } from "./recoverySession.ts";

export const CONSULTATION_ENTRY = "omni-advisor.consultations.v1";
const maxReceipts = 12;
const purposes = ["plan", "decision", "checkpoint", "review"] as const;
const outcomes = ["pending", "completed", "failed", "cancelled", "stale", "unknown"] as const;
type Outcome = (typeof outcomes)[number];
type Settlement = Exclude<Outcome, "pending" | "unknown">;

interface Receipt {
  id: string;
  taskId: string;
  evidenceRevision: number;
  purpose: ConsultationPurpose;
  startedAt: number;
  outcome: Outcome;
  finishedAt?: number;
}
interface LedgerState {
  taskId: string;
  evidenceRevision: number;
  receipts: Receipt[];
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function restore(source: RecoverySessionSource): LedgerState | undefined {
  try {
    const raw = source.getBranch?.().findLast(
      (entry) => entry.type === "custom" && entry.customType === CONSULTATION_ENTRY,
    )?.data as Partial<LedgerState> | undefined;
    if (!raw || !isId(raw.taskId) || !isNumber(raw.evidenceRevision) ||
        !Array.isArray(raw.receipts) || raw.receipts.length > maxReceipts) return;
    const receipts: Receipt[] = [];
    for (const item of raw.receipts) {
      if (!item || !isId(item.id) || !isId(item.taskId) || !isNumber(item.evidenceRevision) ||
          item.evidenceRevision > raw.evidenceRevision || !isNumber(item.startedAt) ||
          !purposes.includes(item.purpose) || !outcomes.includes(item.outcome) ||
          (item.finishedAt !== undefined && !isNumber(item.finishedAt)) ||
          receipts.some((receipt) => receipt.id === item.id)) return;
      // A lost process cannot establish whether a submitted request was billed.
      receipts.push({
        id: item.id,
        taskId: item.taskId,
        evidenceRevision: item.evidenceRevision,
        purpose: item.purpose,
        startedAt: item.startedAt,
        outcome: item.outcome === "pending" ? "unknown" : item.outcome,
        finishedAt: item.finishedAt,
      });
    }
    return { taskId: raw.taskId, evidenceRevision: raw.evidenceRevision, receipts };
  } catch {
    return undefined;
  }
}

/** Bounded local bookkeeping. Never stores a brief, response, or replayable request. */
export class ConsultationLedger {
  private readonly state: LedgerState;
  private readonly write?: (data: LedgerState) => boolean;
  private persisted: boolean;

  constructor(source: RecoverySessionSource, write?: (data: LedgerState) => boolean) {
    const saved = restore(source);
    this.state = saved ?? { taskId: randomUUID(), evidenceRevision: 0, receipts: [] };
    this.persisted = saved !== undefined;
    this.write = write;
  }

  beginTask(): void {
    this.state.taskId = randomUUID();
    this.persist();
  }

  observeEdit(): void {
    this.state.evidenceRevision++;
    this.persist();
  }

  begin(purpose: ConsultationPurpose): Receipt {
    const receipt: Receipt = {
      id: randomUUID(),
      taskId: this.state.taskId,
      evidenceRevision: this.state.evidenceRevision,
      purpose,
      startedAt: Date.now(),
      outcome: "pending",
    };
    this.state.receipts.push(receipt);
    this.state.receipts = this.state.receipts.slice(-maxReceipts);
    this.persist();
    return receipt;
  }

  finish(receipt: Receipt, outcome: Settlement): void {
    if (receipt.outcome !== "pending") return;
    receipt.outcome = outcome;
    receipt.finishedAt = Date.now();
    this.persist();
  }

  private freshness(receipt: Receipt): "current" | "prior-task" | "changed-evidence" {
    if (receipt.taskId !== this.state.taskId) return "prior-task";
    return receipt.evidenceRevision === this.state.evidenceRevision ? "current" : "changed-evidence";
  }

  isCurrent(receipt: Receipt): boolean {
    return this.freshness(receipt) === "current";
  }

  snapshot() {
    return {
      taskId: this.state.taskId,
      evidenceRevision: this.state.evidenceRevision,
      persistence: this.persisted ? "session-entry" : "memory-only",
      recent: this.state.receipts.map((receipt) => ({ ...receipt, freshness: this.freshness(receipt) })),
    };
  }

  private persist(): void {
    if (!this.write || !this.state.receipts.length) return;
    this.persisted = this.write({
      ...this.state,
      receipts: this.state.receipts.map((receipt) => ({ ...receipt })),
    });
  }
}
