import { RecoverySessions, type RecoverySessionSource } from "./recoverySession.ts";

interface Context {
  sessionManager: RecoverySessionSource;
}
/** Coordinates session identity and continuation. Does not decide retry policy or own project memory. */
export class SessionCoordinator {
  readonly recoverySessions: RecoverySessions;
  private ephemeralKeys = new WeakMap<object, string>();
  private sequence = 0;
  private continuation = new Map<string, "input" | "compact">();

  private sessionKey: (ctx: Context) => string;
  constructor(
    sessionKey: (ctx: Context) => string,
    append?: (type: string, data: unknown) => void,
  ) {
    this.sessionKey = sessionKey;
    this.recoverySessions = new RecoverySessions(append);
  }
  recoveryKey(ctx: Context): string {
    const key = this.sessionKey(ctx);
    if (key !== "unknown") return key;
    const identity =
      ctx.sessionManager && typeof ctx.sessionManager === "object"
        ? ctx.sessionManager
        : ctx;
    if (!this.ephemeralKeys.has(identity))
      this.ephemeralKeys.set(identity, `ephemeral:${++this.sequence}`);
    return this.ephemeralKeys.get(identity)!;
  }
  recovery(ctx: Context) {
    return this.recoverySessions.get(this.recoveryKey(ctx), ctx.sessionManager);
  }
  restore(ctx: Context): void {
    this.recoverySessions.restore(this.recoveryKey(ctx), ctx.sessionManager);
  }
  input(ctx: Context, text: string): void {
    const key = this.recoveryKey(ctx);
    this.continuation.set(key, "input");
    this.recoverySessions.get(key, ctx.sessionManager).userInput(text);
    this.recoverySessions.save(key);
  }
  compact(ctx: Context): void {
    const key = this.recoveryKey(ctx);
    if (!this.continuation.has(key)) this.continuation.set(key, "compact");
  }
  /** Consume each continuation signal once; new user input takes precedence over compaction. */
  beginsTask(ctx: Context, reason: string): boolean {
    const key = this.recoveryKey(ctx);
    const continuation = this.continuation.get(key);
    this.continuation.delete(key);
    return reason !== "revive" && continuation !== "compact";
  }
  forget(ctx: Context): void {
    const key = this.recoveryKey(ctx);
    this.recoverySessions.forget(key);
    this.continuation.delete(key);
  }
}
