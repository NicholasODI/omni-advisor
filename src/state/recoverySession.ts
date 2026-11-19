import { RECOVERY_ENTRY, RecoveryController } from "../workflow/recovery.ts";
export interface RecoverySessionSource {
  getSessionFile?(): string;
  getBranch?(): Array<{ type: string; customType?: string; data?: unknown }>;
}
interface RecoverySession {
  controller: RecoveryController;
  durable: boolean;
  lastWrite?: string;
}
/** Session-owned custom entries; no shared filesystem protocol or project memory. */
export class RecoverySessions {
  private sessions = new Map<string, RecoverySession>();
  private readonly append?: (type: string, data: unknown) => void;
  constructor(append?: (type: string, data: unknown) => void) {
    this.append = append;
  }

  get(key: string, session: RecoverySessionSource): RecoveryController {
    return this.sessions.get(key)?.controller ?? this.restore(key, session);
  }
  restore(key: string, session: RecoverySessionSource): RecoveryController {
    const controller = new RecoveryController();
    let durable = false;
    try {
      const entries = session.getBranch?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "custom" && e.customType === RECOVERY_ENTRY) {
          durable = controller.restore(e.data);
          break;
        }
      }
    } catch {
      /* unavailable history: isolated fresh state, never borrow another session */
    }
    this.sessions.set(key, { controller, durable });
    return controller;
  }
  save(key: string): boolean {
    const state = this.sessions.get(key);
    if (!state || !this.append || key === "unknown" || key.startsWith("ephemeral:"))
      return false;
    try {
      const snapshot = state.controller.snapshot();
      const encoded = JSON.stringify(snapshot);
      if (state.lastWrite === encoded) return state.durable;
      this.append(RECOVERY_ENTRY, snapshot);
      state.lastWrite = encoded;
      state.durable = true;
      return true;
    } catch {
      state.durable = false;
      return false;
    }
  }
  persistence(key: string): string {
    if (key === "unknown" || key.startsWith("ephemeral:"))
      return "no stable session identity; memory only";
    return this.append
      ? this.sessions.get(key)?.durable
        ? "session entry saved"
        : "not yet saved or write failed"
      : "host appendEntry unavailable; memory only";
  }
  forget(key: string): void {
    this.sessions.delete(key);
  }
}
