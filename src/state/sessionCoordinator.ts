import { RecoverySessions } from "./recoverySession.ts";

interface Context {
  sessionManager: { getSessionFile?(): string; getBranch?(): any[] };
}
/** Coordinates session identity and continuation. Does not decide retry policy or own project memory. */
export class SessionCoordinator {
  readonly recoverySessions: RecoverySessions;
  private ephemeralKeys = new WeakMap<object, string>();
  private sequence = 0;
  private compacted = new Set<string>();
  private freshInput = new Set<string>();

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
    this.freshInput.add(this.recoveryKey(ctx));
    this.recovery(ctx).userInput(text);
    this.recoverySessions.save(this.recoveryKey(ctx));
  }
  compact(ctx: Context): void {
    this.compacted.add(this.recoveryKey(ctx));
  }
  /** Consume each continuation signal once; new user input takes precedence over compaction. */
  beginsTask(ctx: Context, reason: string): boolean {
    const key = this.recoveryKey(ctx);
    const continuation = this.compacted.has(key) && !this.freshInput.has(key);
    this.compacted.delete(key);
    this.freshInput.delete(key);
    return reason !== "revive" && !continuation;
  }
  forget(ctx: Context): void {
    this.recoverySessions.forget(this.recoveryKey(ctx));
    const key = this.recoveryKey(ctx);
    this.compacted.delete(key);
    this.freshInput.delete(key);
  }
}
