/** One reassessment hint per task, even when reads/edits interrupt a failing test loop. */
export class RecoveryGuard {
  private failures = new Map<string, number>();
  private prompted = false;
  reset(): void { this.failures.clear(); this.prompted = false; }
  observe(tool: string, input: Record<string, unknown>, error: boolean): boolean {
    if (this.prompted || !error) return false;
    // Count command/evaluation failures together: switching runners is not recovery.
    let target: string;
    if (tool === 'bash' || tool === 'eval') target = 'execution';
    else if (tool === 'edit' || tool === 'write') {
      const anchor = typeof input.input === 'string' ? input.input.match(/^\[([^\n#]+)(?:#[^\n]*)?\]/)?.[1] : undefined;
      target = `file:${String(input.path ?? anchor ?? 'unknown')}`;
    } else return false;
    const count = (this.failures.get(target) ?? 0) + 1;
    this.failures.set(target, count);
    if (count < 3) return false;
    this.prompted = true;
    return true;
  }
}
export const recoveryHint = `STOP this retry loop and reassess the approach before another attempt. Repeated failures may be in the test harness or tooling, not the product. If cloud access is enabled and budget permits, call ask_advisor ONCE with an abstract brief: user goal and allowed testing scope, product changes already made, checks that passed, and the repeated failure category. Ask: "Should I continue, simplify verification, or stop? Give one next action and a stopping condition." Do not ask merely how to fix the next harness failure; do not send code, paths, raw errors, or internal deliberation. Follow the recommendation within the user's scope. If advice is unavailable, use the smallest meaningful existing check and report what remains unverified; do not build a replacement browser/test framework or bypass planning enforcement.`;
