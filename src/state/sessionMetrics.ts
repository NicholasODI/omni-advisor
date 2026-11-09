/** Metadata only. Durations can overlap; tool time is not model inference time. */
export class SessionMetrics {
  successful = 0; failed = 0; blocked = 0; cloudMs = 0; toolMs = 0;
  inputTokens = 0; outputTokens = 0; usageMissing = 0;
  private tools = new Map<string, number>();
  private failures = new Map<string, number>();
  private started?: number;
  private elapsedMs = 0;
  begin(now = Date.now()): void { if (this.started === undefined) this.started = now; }
  end(now = Date.now()): void { if (this.started !== undefined) this.elapsedMs += now - this.started; this.started = undefined; }
  toolStart(id: string, now = Date.now()): void { this.tools.set(id, now); }
  toolEnd(id: string, name: string, error: boolean, now = Date.now()): boolean {
    const start = this.tools.get(id); if (start !== undefined) this.toolMs += now - start;
    this.tools.delete(id);
    const n = error ? (this.failures.get(name) ?? 0) + 1 : 0;
    this.failures.set(name, n); return n === 3;
  }
  result(ok: boolean, ms: number, usage?: { input: number; output: number }): void {
    if (ok) this.successful++; else this.failed++; this.cloudMs += ms;
    if (usage) { this.inputTokens += usage.input; this.outputTokens += usage.output; }
    else this.usageMissing++;
  }
  snapshot(now = Date.now()) {
    return { successful: this.successful, failed: this.failed, locallyBlocked: this.blocked,
      cloudLatencyMs: this.cloudMs, cumulativeToolMs: this.toolMs,
      agentWallMs: this.elapsedMs + (this.started === undefined ? 0 : now - this.started),
      cloudInputTokens: this.inputTokens, cloudOutputTokens: this.outputTokens, responsesWithoutUsage: this.usageMissing,
      cost: 'unknown', inferenceTime: 'not exposed by host; timings may overlap', scope: 'current process/session' };
  }
}
