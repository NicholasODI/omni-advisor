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
  return ['objective', 'stack', 'components', 'constraints', 'facts', 'questions', 'previousPlan'].map(k => [k, brief[k as keyof PlanningBrief]]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}
export class PrivacyError extends Error {
  constructor(field: string, category: string) {
    super(`Privacy check blocked field ${field}: ${category}. Rephrase as abstract behavior without sensitive details.`);
  }
}
export function assertAbstract(text: string, field = 'brief'): void {
  if (!text.trim() || text.length > 12000) throw new PrivacyError(field, 'empty or oversized text (maximum 12000 characters)');
  const rules: Array<[string, RegExp]> = [
    ['code or key block', /```|-----BEGIN/],
    ['credential assignment', /\b(?:authorization|cookie|password|api[_-]?key)\s*[:=]/i],
    ['local path', /(?:\/home\/|\/Users\/|\/workspace\/|[A-Z]:\\)/i],
    ['URL', /https?:\/\//i],
  ];
  for (const [category, re] of rules) if (re.test(text)) throw new PrivacyError(field, category);
}
export function validateBrief(brief: PlanningBrief): string {
  for (const field of ['objective', 'stack', 'components', 'constraints', 'facts', 'questions', 'previousPlan'] as const) {
    const value = brief[field]; if (value) assertAbstract(value, field);
  }
  const text = planningText(brief); assertAbstract(text); return text;
}
