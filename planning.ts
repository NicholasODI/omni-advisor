/** Local-only validation before any consultation leaves the device. */
export interface PlanningBrief {
  objective: string;
  stack?: string;
  constraints?: string;
  components?: string;
  facts?: string;
  questions: string;
  previousPlan?: string;
}
export function planningText(brief: PlanningBrief): string {
  return Object.entries(brief).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}
export function assertAbstract(text: string): void {
  if (!text.trim() || text.length > 12000) throw new Error('Provide a non-empty abstract brief of at most 12000 characters.');
  if (/```|-----BEGIN|\b(?:authorization|cookie|password|api[_-]?key)\s*[:=]|(?:\/home\/|\/Users\/|\/workspace\/|[A-Z]:\\)|https?:\/\//i.test(text)) {
    throw new Error('Privacy check blocked this brief. Remove code blocks, credentials, URLs, and local paths; describe behavior and relationships instead.');
  }
}
