import { createHash, randomUUID } from 'node:crypto';
import { assertAbstract } from '../privacy/planning.ts';

export type RecoveryMode = 'disabled' | 'observe' | 'enforce';
export type FailureCategory = 'transport' | 'environment' | 'edit-syntax' | 'assertion' | 'setup' | 'command';
type Outcome = 'passed' | 'failed' | 'skipped' | 'unrun' | 'unknown';
export const RECOVERY_ENTRY = 'omni-advisor.recovery.v1';
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/.test(s);
export function normalizeDiagnostic(text: string): string {
  return text.slice(0, 12000).toLowerCase()
    .replace(/\d{4}-\d\d-\d\d[t ][\d:.+z-]+/g, '<time>')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, '<id>')
    .replace(/(?:[a-z]:[\\/]|\/(?:tmp|var|home|users)\/)[^\s:)]+/g, '<path>')
    .replace(/\b(?:localhost|127\.0\.0\.1):\d+/g, '<service>')
    .replace(/\b(?:lines?|port|pid)\s*[:=]?\s*\d+/g, '<number>')
    .replace(/:\d+(?::\d+)?/g, ':<location>')
    .replace(/#[a-f0-9]{4,}/g, '#<tag>')
    .replace(/\s+/g, ' ').trim();
}
export function operationKey(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'edit' || tool === 'write') {
    const anchor = typeof input.input === 'string' ? input.input.match(/^\[([^\n#]+)(?:#[^\n]*)?\]/)?.[1] : undefined;
    const path = input.path ?? anchor;
    return typeof path === 'string' ? hash(`file:${path.replace(/\\/g, '/').replace(/^\.\//, '')}`) : undefined;
  }
  if (tool === 'bash') {
    if (typeof input.command !== 'string') return undefined;
    // Ignore cosmetic quoting of simple tokens; do not parse shell control flow.
    const command = input.command.replace(/['"]([\w./\\:-]+)['"]/g, '$1').replace(/\s+/g, ' ').trim();
    return hash(`bash:${String(input.cwd ?? '')}:${command}`);
  }
  return tool === 'eval' && typeof input.code === 'string' ? hash(`eval:${input.code.replace(/\s+/g, ' ').trim()}`) : undefined;
}
export interface Observation {
  operation: string; signature: string; category: FailureCategory; outcome: Outcome; compound: boolean;
}
export function classify(tool: string, input: Record<string, unknown>, result: { isError?: boolean; content?: any[]; details?: any }): Observation | undefined {
  const operation = operationKey(tool, input);
  if (!operation) return undefined;
  const text = (result.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').slice(0, 12000);
  const d = result.details ?? {};
  const exit = Number.isInteger(d.exitCode) ? d.exitCode : Number.isInteger(d.exit_code) ? d.exit_code : undefined;
  const tests = d.tests;
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const failedCount = tests && count(tests.failed) && tests.failed > 0;
  const failedLine = text.split('\n').find(line => /^\s*(?:FAIL(?:ED)?\b|[✖×]\s)|^\s*(?:E\s+)?(?:AssertionError|SyntaxError|TypeError|ReferenceError|ECONNREFUSED|ENOENT|command not found|No module named|cannot find module)\b|^\s*(?:=+\s*)?\d+ failed\b|^\s*(?:ℹ\s*)?fail(?:ed)?\s*[:= ]\s*[1-9]\d*|^RESULT pass=\d+ fail=[1-9]\d*|^\s*(?:EXIT|GATE_EXIT|PYTEST_EXIT)=([1-9]\d*)/i.test(line));
  const failed = !!result.isError || (exit !== undefined && exit !== 0) || failedCount || !!failedLine;
  const timedOut=d.timedOut===true;
  let outcome: Outcome = timedOut ? 'unrun' : failed ? 'failed' : 'unknown';
  // A zero exit without runner evidence is not proof that intended tests executed.
  if (!failed && !timedOut && tests && count(tests.passed) && count(tests.failed)) outcome = tests.passed > 0 ? 'passed' : tests.skipped > 0 ? 'skipped' : 'unrun';
  else if (!failed && !timedOut && /\b0 (?:tests?|passed)\b/.test(text)) outcome = 'unrun';
  else if (!failed && !timedOut && /\b[1-9]\d* passed\b|^\s*(?:ℹ\s*)?pass [1-9]\d*\s*$/m.test(text)) outcome = 'passed';
  else if (!failed && !timedOut && (tool === 'edit' || tool === 'write')) outcome = 'passed';
  let category: FailureCategory = outcome === 'unrun' ? 'setup' : 'command';
  const diagnostic = timedOut ? 'execution deadline expired before completion' : failedLine ?? (typeof d.error?.code === 'string' ? d.error.code : failed ? text.split('\n').find(l => l.trim()) ?? 'tool failure' : outcome);
  if (d.transportError === true) category = 'transport';
  else if (timedOut) category = 'environment';
  else if ((tool === 'edit' || tool === 'write') && failed) category = 'edit-syntax';
  else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENOENT|not found|not recognized as|No module named|cannot find module|unavailable/i.test(diagnostic)) category = 'environment';
  else if (/SyntaxError|TypeError|ReferenceError|fixture|setup|collection|collecting/i.test(diagnostic)) category = 'setup';
  else if (failedCount || /assert|\bFAIL/i.test(diagnostic)) category = 'assertion';
  const canonical = category === 'edit-syntax' && /column cap|no retained read/i.test(diagnostic) ? 'edit display cap requires fresh read'
    : category === 'edit-syntax' && /stale.*(?:tag|anchor)|(?:tag|anchor).*mismatch/i.test(diagnostic) ? 'edit stale anchor'
    : normalizeDiagnostic(diagnostic);
  return { operation, signature: hash(`${category}:${canonical}`), category, outcome,
    compound: tool === 'bash' && /&&|\|\||[;\n]/.test(String(input.command)) };
}
export interface RecoveryDecision {
  hypothesis: string; changed: string; nextAction: string; expectedEvidence: string; stopWhen: string;
  actionTool: 'bash' | 'eval' | 'edit' | 'write'; actionInput: Record<string, unknown>;
}
interface Episode {
  id: string; operation: string; signature: string; category: FailureCategory; attempts: number;
  phase: 'suspected' | 'required' | 'authorized' | 'resolved' | 'retired' | 'blocked';
  outcomes: Outcome[]; evidenceRevision: number; compound: boolean; adviceRequested: boolean;
  decisions: Array<{ hypothesis: string; remedy: string; revision: number }>;
  decision?: { hypothesis: string; changed: string; nextAction: string; expectedEvidence: string; stopWhen: string };
  authorizedOperation?: string; overrideReason?: string;
}
export interface RecoveryState { version: 1; taskId: string; revision: number; episodes: Episode[]; }
export class RecoveryController {
  private state: RecoveryState = { version: 1, taskId: randomUUID(), revision: 0, episodes: [] };
  private activeCalls = new Map<string, string>();
  private callTasks = new Map<string,string>();
  private blockedCalls = new Set<string>();
  snapshot(): RecoveryState { return structuredClone(this.state); }
  // Only controller-produced, bounded schema is restored. Arbitrary session text is never executed.
  restore(raw: unknown): boolean {
    try {
      if (JSON.stringify(raw).length > 32000) return false;
      const s = raw as RecoveryState;
      if (s.version !== 1 || !/^[a-f0-9-]{36}$/.test(s.taskId) || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.episodes) || s.episodes.length > 8) return false;
      const categories = ['transport','environment','edit-syntax','assertion','setup','command'];
      for (const e of s.episodes) {
        if (!digest(e.id) || !digest(e.operation) || !digest(e.signature) || !categories.includes(e.category) || !['suspected','required','authorized','resolved','retired','blocked'].includes(e.phase) || !Number.isSafeInteger(e.attempts) || e.attempts < 1 || e.attempts > 10000 || !Number.isSafeInteger(e.evidenceRevision) || e.evidenceRevision < 0 || typeof e.adviceRequested !== 'boolean' || typeof e.compound !== 'boolean' || e.authorizedOperation !== undefined && !digest(e.authorizedOperation)) return false;
        if (!Array.isArray(e.outcomes) || e.outcomes.length > 6 || e.outcomes.some(o => !['passed','failed','skipped','unrun','unknown'].includes(o)) || !Array.isArray(e.decisions) || e.decisions.length > 4) return false;
        for (const d of e.decisions) if (!digest(d.hypothesis) || !digest(d.remedy) || !Number.isSafeInteger(d.revision)) return false;
        if (e.decision) for (const k of ['hypothesis','changed','nextAction','expectedEvidence','stopWhen'] as const) this.safe(e.decision[k]);
        if (e.overrideReason !== undefined) this.safe(e.overrideReason);
      }
      // Rebuild the allowlisted structure; do not preserve unknown sensitive fields.
      this.state = { version:1, taskId:s.taskId, revision:s.revision, episodes:s.episodes.map(e => ({
        id:e.id, operation:e.operation, signature:e.signature, category:e.category, attempts:e.attempts, phase:e.phase,
        outcomes:[...e.outcomes], evidenceRevision:e.evidenceRevision, compound:e.compound, adviceRequested:e.adviceRequested,
        decisions:e.decisions.map(d=>({hypothesis:d.hypothesis,remedy:d.remedy,revision:d.revision})),
        ...(e.decision ? {decision:{hypothesis:e.decision.hypothesis,changed:e.decision.changed,nextAction:e.decision.nextAction,expectedEvidence:e.decision.expectedEvidence,stopWhen:e.decision.stopWhen}} : {}),
        ...(e.authorizedOperation ? {authorizedOperation:e.authorizedOperation} : {}), ...(e.overrideReason ? {overrideReason:e.overrideReason} : {}),
      })) };
      // Never replay an in-flight authorization after a crash/reload.
      for (const e of this.state.episodes) if (e.phase === 'authorized') {e.phase='required';delete e.authorizedOperation;}
      return true;
    } catch {return false;}
  }
  newTask(): void { this.state = {version:1,taskId:randomUUID(),revision:0,episodes:[]}; this.activeCalls.clear(); }
  private safe(value: unknown): string {
    if (typeof value !== 'string' || value.length > 300) throw new Error('Use short abstract recovery fields (maximum 300 characters), no raw diagnostics or private values.');
    assertAbstract(value, 'recovery decision'); return value;
  }
  private episode(id: string): Episode {
    const e=this.state.episodes.find(e=>e.id===id); if (!e) throw new Error('Recovery episode is no longer active.'); return e;
  }
  decide(id: string, d: RecoveryDecision): void {
    const e=this.episode(id);
    if (!['required','blocked'].includes(e.phase)) throw new Error('This episode does not need another decision.');
    const decision = {hypothesis:this.safe(d.hypothesis),changed:this.safe(d.changed),nextAction:this.safe(d.nextAction),expectedEvidence:this.safe(d.expectedEvidence),stopWhen:this.safe(d.stopWhen)};
    const op=operationKey(d.actionTool,d.actionInput); if (!op) throw new Error('Specify one exact supported recovery action.');
    const hypothesis=hash(normalizeDiagnostic(decision.hypothesis)),remedy=op;
    if (e.decisions.some(old=>old.remedy===remedy && old.revision===this.state.revision)) throw new Error('This hypothesis/action was already attempted without an observed edit or distinguishing evidence. Choose a different diagnostic/remedy or report a blocker.');
    e.decision=decision; e.decisions.push({hypothesis,remedy,revision:this.state.revision});e.decisions=e.decisions.slice(-4);
    e.phase='authorized';e.authorizedOperation=op;
  }
  override(id: string, reason: string): void { const e=this.episode(id);e.overrideReason=this.safe(reason);e.phase='authorized';e.authorizedOperation=e.operation; }
  block(id: string, reason: string): void {const e=this.episode(id);e.decision={hypothesis:'External prerequisite unavailable',changed:this.safe(reason),nextAction:'Report blocker',expectedEvidence:'Prerequisite becomes available',stopWhen:'Do not retry until prerequisite changes'};e.phase='blocked';}
  advice(id: string): boolean {const e=this.episode(id);if(e.adviceRequested)return false;e.adviceRequested=true;return true;}
  start(callId: string, tool: string, input: Record<string, unknown>, enforce: boolean): string | undefined {
    const op=operationKey(tool,input);if(!op)return;
    const locked=this.state.episodes.find(e=>e.operation===op && ['required','blocked'].includes(e.phase));
    if(enforce && locked){this.blockedCalls.add(callId);if(this.blockedCalls.size>64)this.blockedCalls.delete(this.blockedCalls.values().next().value!);return locked.id;}
    this.blockedCalls.delete(callId);
    this.callTasks.set(callId,this.state.taskId);
    if(this.callTasks.size>64)this.callTasks.delete(this.callTasks.keys().next().value!);
    const authorized=this.state.episodes.find(e=>e.phase==='authorized' && e.authorizedOperation===op);
    if(authorized){authorized.phase='required';delete authorized.authorizedOperation;this.activeCalls.set(callId,authorized.id);if(this.activeCalls.size>32)this.activeCalls.delete(this.activeCalls.keys().next().value!);}
    return;
  }
  observe(callId: string, tool: string, input: Record<string, unknown>, result: {isError?:boolean;content?:any[];details?:any}, threshold=3): Episode | undefined {
    const startedTask=this.callTasks.get(callId);this.callTasks.delete(callId);
    if(this.blockedCalls.delete(callId) || startedTask && startedTask!==this.state.taskId)return;
    const observation=classify(tool,input,result);if(!observation)return;
    const active=this.activeCalls.get(callId);this.activeCalls.delete(callId);
    const unsuccessful=observation.outcome==='failed'||observation.outcome==='unrun';
    if (observation.outcome==='passed' && (tool==='edit'||tool==='write')) this.state.revision++;
    // A diagnostic does not resolve the original check; its next retry needs another decision.
    if(active && !unsuccessful) {
      const e=this.episode(active);e.phase=observation.operation===e.operation && observation.outcome==='passed' ? 'resolved':'required';
      if(observation.operation!==e.operation){e.outcomes.push(observation.outcome);e.outcomes=e.outcomes.slice(-6);}
    }
    if(!unsuccessful) {
      const matched=this.state.episodes.slice().reverse().find(e=>e.operation===observation.operation && e.phase!=='retired');
      if(matched){matched.outcomes.push(observation.outcome);matched.outcomes=matched.outcomes.slice(-6);if(observation.outcome==='passed') {matched.phase='resolved';matched.evidenceRevision=this.state.revision;}}
      return;
    }
    for (const prior of this.state.episodes) if(prior.operation===observation.operation && prior.signature!==observation.signature && !['resolved','retired'].includes(prior.phase)) prior.phase='retired';
    let e=this.state.episodes.find(e=>e.operation===observation.operation && e.signature===observation.signature && !['resolved','retired'].includes(e.phase));
    if(!e){e={id:hash(randomUUID()),operation:observation.operation,signature:observation.signature,category:observation.category,attempts:0,phase:'suspected',outcomes:[],evidenceRevision:this.state.revision,compound:observation.compound,adviceRequested:false,decisions:[]};this.state.episodes.push(e);this.state.episodes=this.state.episodes.slice(-8);}
    e.attempts=Math.min(10000,e.attempts+1);e.outcomes.push(observation.outcome);e.outcomes=e.outcomes.slice(-6);
    if(e.attempts>=threshold){const notify=e.phase==='suspected';e.phase='required';return notify ? e : undefined;}
  }
  summary() { return {...this.snapshot(), episodes:this.state.episodes.map(e=>({...e, evidenceFresh:e.evidenceRevision===this.state.revision, revisionScope:'observed successful edits/writes only; external changes unknown'}))}; }
}
export const recoveryHint = `Recovery decision required before another equivalent retry. Use advisor_recovery to inspect the episode and record ONE short hypothesis, what changed, next action, expected distinguishing evidence, and stopping condition. Prefer a targeted diagnostic or materially different remedy; report a blocker if prerequisites are unavailable. Cloud is optional: if allowed, use ask_advisor with recoveryEpisode and an abstract brief asking whether to continue, simplify verification, or stop. Never upload raw diagnostics, code, paths, or session history. Advice cannot expand scope or weaken assertions. Preserve required final gates; do not stop testing solely because a counter fired.`;
