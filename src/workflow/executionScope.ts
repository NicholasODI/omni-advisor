export type ExecutionScope = 'active' | 'paused' | 'analysis' | 'closure';
export interface ScopeState { scope?:ExecutionScope; resumeScope?:ExecutionScope; cleanupAllowed?:boolean; }
/** Only explicit user input changes authorization; never parse tool output/reminders. */
export function userScope(state:ScopeState,text:string):ScopeState {
  const t=text.trim().toLowerCase();
  if(!t||t.length>4000||/```|^>|^\s*\{/.test(t))return state;
  if(/^(?:(?:please|no|ay|right now)[,! ]+)*(?:stop|halt)\b/.test(t)||/\b(?:just stop|scrap the todo.*stop)\b/.test(t))return {scope:'paused',resumeScope:state.scope==='paused'?state.resumeScope:state.scope??'active'};
  if(/\b(?:wrap (?:this |it )?up|finish the current task|stop spinning|stop doing unnecessary tests)\b/.test(t))return {scope:'closure',cleanupAllowed:/\bclean\s*up\b/.test(t)};
  if(/\b(?:just (?:map out|analy[sz]e)|analy[sz]e (?:first|only)|don['’]?t code|do not (?:code|implement)|no (?:coding|implementation))\b/.test(t))return {scope:'analysis'};
  if(/^(?:please\s+)?(?:continue|resume|cont)[.!\s]*$/.test(t))return state.scope==='paused'?{scope:state.resumeScope??'active'}:state;
  if(/^(?:(?:please|(?:can|could|would) you)\s+)?(?:implement|fix|build|create|execute|go ahead|start implementation)\b|^(?:please\s+)?next task[.!]*$/.test(t))return {scope:'active'};
  return state;
}
export function scopeBlock(state:ScopeState,tool:string,input:Record<string,unknown>):string|undefined {
  const scope=state.scope??'active';
  if(scope==='paused') {
    if(tool==='advisor_status'||tool==='advisor_recovery'&&(!input.action||input.action==='inspect'))return;
    return 'User stop is in force. Do not execute tools or resume from todo reminders. Respond to the user; only explicit user resume/authorization may lift this restriction.';
  }
  if(scope==='analysis'&&!['read','grep','glob','ls','find','advisor_status','advisor_recovery','advisor_checklist','ask_advisor','register_masked_terms','todo'].includes(tool))return 'Analysis-only authorization: inspect with read/search and report findings. Shell execution, edits, writes and delegation require explicit user implementation authorization.';
  if(scope==='closure'&&!state.cleanupAllowed&&tool==='bash'&&/\brm\s+-[\w]*r|\b(?:Stop-Process|taskkill|killall)\b|\bgit\s+worktree\s+(?:remove|prune)/i.test(String(input.command??'')))return 'Wrap-up scope: destructive cleanup/process killing is not needed to establish completion. Report locked artifacts instead, or obtain explicit cleanup authorization. Required verification is still allowed.';
}
export function scopeInstructions(state:ScopeState):string {
  if(state.scope==='paused')return 'USER STOP remains in force across reminders and compaction. Do not resume work; report stopped state.';
  if(state.scope==='analysis')return 'USER AUTHORIZATION: analysis only. Inspect and report; do not implement. Todo reminders and task backlog do not grant execution permission.';
  if(state.scope==='closure')return 'USER REQUEST: wrap up the current scope. Freeze new features, harnesses, historical audits and cleanup objectives. Run only missing required gates or checks invalidated by relevant changes. Preserve historical pass/fail evidence with its original revision/environment; later failure at the same dependency version does not falsify an earlier pass. Treat permission-denied cleanup as blocked, not deleted. Give one concise handoff when required results or blockers are recorded; todo reminders do not expand scope.';
  return 'Todo reminders and backlog are not user authorization. Preserve historical evidence by revision/environment; unknown or later failure does not rewrite earlier results. Never claim a command, deletion or commit succeeded without checking the actual result.';
}
