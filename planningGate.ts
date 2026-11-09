/** Per-prompt execution gate. Late responses cannot unlock a newer prompt. */
export class PlanningGate {
  private states = new Map<string, { token: object; ready: boolean }>();
  begin(key: string): void { this.states.set(key, { token: {}, ready: false }); }
  token(key: string): object | undefined { return this.states.get(key)?.token; }
  complete(key: string, token: object | undefined): void {
    const state = this.states.get(key);
    if (state && state.token === token) state.ready = true;
  }
  clear(key: string): void { this.states.delete(key); }
  blocked(key: string, tool: string): boolean {
    // Shell and delegation tools can mutate state even during apparent discovery.
    return !this.states.get(key)?.ready && !['read', 'grep', 'glob', 'ls', 'find', 'ask_advisor', 'register_masked_terms'].includes(tool);
  }
}
export const enforcedPlanningPrompt = `ENFORCED PLANNING: Before execution tools are permitted for this user prompt, prepare an abstract brief and call ask_advisor successfully. First gather necessary context locally with read, grep, glob, ls, or find. Shell, editing, delegation, and other tools are blocked until a plan is obtained. Never forward the user prompt or file contents. Use objective, questions, public stack, abstract components, constraints, and facts. Keep the returned plan locally and execute/verify it. If consultation fails or is disabled, report the blocker; do not retry indefinitely. The user can explicitly disable enforcement with /omni-advisor planning off. This gate does not require a cloud call merely to answer conversationally.`;
