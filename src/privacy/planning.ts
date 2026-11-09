/** Only these explicitly selected abstractions may enter a consultation. */
export type ConsultationPurpose = 'plan' | 'decision' | 'checkpoint' | 'review';
export interface PlanningBrief {
  purpose?: ConsultationPurpose;
  objective: string;
  stack?: string;
  constraints?: string;
  components?: string;
  facts?: string;
  invariants?: string;
  alternatives?: string;
  outcomes?: Array<{ check: string; status: 'passed' | 'failed' | 'unverified'; summary: string }>;
  questions: string;
  previousPlan?: string;
}
const limits = { objective: 3000, stack: 1000, components: 2000, constraints: 2000, facts: 2000,
  invariants: 2000, alternatives: 1500, questions: 3000, previousPlan: 2000 };
export function planningText(brief: PlanningBrief): string {
  const fields: Array<[string, unknown]> = [['purpose', brief.purpose ?? 'plan'], ...Object.keys(limits).map(k => [k, brief[k as keyof PlanningBrief]] as [string, unknown])];
  if (brief.outcomes?.length) fields.push(['outcomes', brief.outcomes.map(o => `${o.check}: ${o.status} — ${o.summary}`).join('\n')]);
  return fields.filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('\n');
}
export class PrivacyError extends Error {
  constructor(field: string, category: string) {
    super(`Privacy check blocked field ${field}: ${category}. Rephrase as abstract behavior without sensitive details.`);
  }
}
/** Heuristic rejection, not a proof that prose contains no confidential meaning. */
export function assertAbstract(text: string, field = 'brief'): void {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new PrivacyError(field, 'empty, invalid, or oversized text (maximum 12000 characters)');
  const rules: Array<[string, RegExp]> = [
    ['code or key block', /```|-----BEGIN|(?:^|\n)\s*(?:import\s+.+\s+from\s+|(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|class\s+\w+\s*[{:]|(?:const|let|var)\s+\w+\s*=)/m],
    ['credential or authentication data', /\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|secret)\s*[:=]|\bBearer\s+\S+|\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i],
    ['local path', /(?:[A-Z]:[\\/]|\\\\[A-Za-z0-9_-]+\\|(?:^|[\s"'=:(])\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*|(?:^|[\s"'=:(])(?:\.\.?\/|~\/)[A-Za-z0-9_.-]+)/im],
    ['URL or internal network identifier', /[a-z][a-z0-9+.-]*:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[a-f0-9:]*:[a-f0-9:]+\]|\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:internal|local|corp|lan)\b/i],
    ['personal identifier', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){15,19}\b/],
    ['raw records, markup, or log/trace output', /\{\s*["'][^"'\n]+["']\s*:|<\/?[A-Za-z][^>\n]*>|(?:^|\n)\s*(?:Traceback \(most recent call last\)|at\s+\S+\s+\([^\n]*:\d+|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/m],
  ];
  for (const [category, re] of rules) if (re.test(text)) throw new PrivacyError(field, category);
}
export function validateBrief(brief: PlanningBrief): string {
  if (!brief || typeof brief !== 'object') throw new PrivacyError('brief', 'invalid structure');
  if (brief.purpose !== undefined && !['plan', 'decision', 'checkpoint', 'review'].includes(brief.purpose)) throw new PrivacyError('purpose', 'unsupported consultation type');
  for (const [field, max] of Object.entries(limits)) {
    const value = brief[field as keyof typeof limits];
    if ((field === 'objective' || field === 'questions') && !value) throw new PrivacyError(field, 'required abstract field missing');
    if (value !== undefined) {
      assertAbstract(value, field);
      if (value.length > max) throw new PrivacyError(field, `maximum ${max} characters`);
    }
  }
  if (brief.outcomes !== undefined) {
    if (!Array.isArray(brief.outcomes) || brief.outcomes.length > 8) throw new PrivacyError('outcomes', 'maximum eight summarized checks');
    for (const outcome of brief.outcomes) {
      if (!outcome || !['passed', 'failed', 'unverified'].includes(outcome.status)) throw new PrivacyError('outcomes', 'invalid check status');
      assertAbstract(outcome.check, 'outcomes.check'); assertAbstract(outcome.summary, 'outcomes.summary');
      if (outcome.check.length > 200 || outcome.summary.length > 500) throw new PrivacyError('outcomes', 'summarize check names and outcomes');
    }
  }
  const text = planningText(brief); assertAbstract(text); return text;
}
