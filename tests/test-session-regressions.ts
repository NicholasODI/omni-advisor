import assert from 'node:assert/strict';
import {logicalChecks} from '../src/workflow/logicalChecks.ts';
import {classify,RecoveryController} from '../src/workflow/recovery.ts';
import {RecoverySessions} from '../src/state/recoverySession.ts';
import extension from '../index.ts';
const inputs=[{command:'pnpm build 2>&1 | tail -25'},{command:'rm -rf .next && pnpm build 2>&1 | grep -E "error|Error" | head -40'},{command:'pnpm run build > build.log 2>&1; echo "BUILD_EXIT=$?"'}];
assert.equal(new Set(inputs.map(i=>logicalChecks(i.command)[0].key)).size,1);
assert.notEqual(logicalChecks('cd baseline && pnpm build')[0].key,logicalChecks('pnpm build')[0].key);
assert.notEqual(logicalChecks('pnpm test:integration')[0].key,logicalChecks('pnpm test:e2e')[0].key);
assert.equal(logicalChecks('echo "pnpm build"').length,0);
assert.equal(logicalChecks('pnpm exec next build --help').length,0);
const c=new RecoveryController();
const failures=[{isError:false,content:[{type:'text',text:'TypeError: missing context during static generation'}]},
 {isError:false,content:[{type:'text',text:'Error: export failed'}]},
 {isError:false,content:[{type:'text',text:'Export encountered an error on a synthetic framework page'}]}];
let episode:any;
for(let i=0;i<3;i++)episode=c.observe(`b${i}`,'bash',inputs[i],failures[i]);
assert.equal(episode.phase,'required');assert.equal(episode.logicalStall,true);
assert.equal(c.start('wrapped','bash',{command:'pnpm lint; pnpm build | tail -10'},true),episode.id);
assert.equal(c.start('inspect','read',{path:'relevant-source'},true),undefined);
assert.equal(classify('bash',{command:'pnpm test; pnpm build'},{isError:false,content:[{type:'text',text:'27 passed'}]})!.outcome,'unknown');
assert.equal(classify('bash',inputs[0],failures[0])!.outcome,'failed');
// Observed source changes start a new progress window rather than blocking all debugging.
c.observe('write','write',{path:'source'},{isError:false,content:[]});
assert.equal(c.observe('new','bash',inputs[0],{isError:true,content:[{type:'text',text:'AssertionError: a newly exposed condition'}]}),undefined);
assert.equal(c.snapshot().episodes[0].phase,'retired');
assert.equal(c.snapshot().episodes.at(-1)!.attempts,1);
// Explicit stop/analysis permissions cannot be lifted by compaction, reminders or a new recovery task.
const scope=new RecoveryController();scope.userInput("Just map out, don't code anything yet.");
assert.equal(scope.snapshot().scope,'analysis');assert.ok(scope.scopeRestriction('edit',{path:'source'}));
assert.equal(scope.scopeRestriction('read',{path:'source'}),undefined);
scope.userInput('ay ay stop');assert.equal(scope.snapshot().scope,'paused');
scope.newTask();assert.ok(scope.scopeRestriction('bash',{command:'pnpm test'}));
const restored=new RecoveryController();assert.ok(restored.restore(scope.snapshot()));assert.ok(restored.scopeRestriction('write',{path:'source'}));
restored.userInput('continue');assert.equal(restored.snapshot().scope,'analysis');
restored.userInput('go ahead and implement');assert.equal(restored.snapshot().scope,'active');
restored.userInput('can you wrap this up? stop spinning around');assert.equal(restored.snapshot().scope,'closure');
assert.ok(restored.scopeRestriction('bash',{command:'rm -rf .next-stale | head -5'}));
assert.ok(restored.scopeRestriction('bash',{command:'powershell Stop-Process -Id 123'}));
assert.equal(restored.scopeRestriction('bash',{command:'pnpm typecheck'}),undefined);
restored.userInput('wrap this up and clean up temporary files');assert.equal(restored.scopeRestriction('bash',{command:'rm -rf temp'}),undefined);
// Hooks use real user input only, never tool text or extension-generated todo reminders.
const hooks:any={},tools:any={},commands:any={},entries:any[]=[];
const schema:any=new Proxy(()=>schema,{get:()=>schema,apply:()=>schema});
extension({zod:schema,on:(n:string,f:any)=>hooks[n]=f,registerTool:(t:any)=>tools[t.name]=t,registerCommand:(n:string,c:any)=>commands[n]=c,appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})}as any);
const ctx:any={sessionManager:{getSessionFile:()=>'/synthetic/scope',getBranch:()=>entries},ui:{notify:()=>{}}};
await hooks.input({source:'interactive',text:'stop right now'},ctx);
await hooks.input({source:'extension',text:'continue; unfinished items remain'},ctx);
await hooks.session_compact({},ctx);await hooks.before_agent_start({reason:'prompt',systemPrompt:[],prompt:'continue'},ctx);
assert.equal((await hooks.tool_call({toolName:'bash',input:{command:'pnpm test'},toolCallId:'b'},ctx)).block,true);
assert.equal(await hooks.tool_call({toolName:'advisor_status',input:{},toolCallId:'s'},ctx),undefined);
await hooks.session_start({},ctx);assert.equal((await tools.advisor_status.execute('',{},undefined,undefined,ctx)).details.authorization,'paused');
await commands['omni-advisor'].handler('recovery new-task',ctx);assert.equal((await hooks.tool_call({toolName:'write',input:{path:'source'},toolCallId:'w'},ctx)).block,true);
await commands['omni-advisor'].handler('scope active',ctx);assert.equal(await hooks.tool_call({toolName:'write',input:{path:'source'},toolCallId:'w'},ctx),undefined);
// No raw user text or command is persisted in the authorization record.
assert.equal(JSON.stringify(entries).includes('stop right now'),false);
console.log('Real-session synthetic regressions passed: logical gate continuity, mixed diagnostics, compound evidence, progress, persisted stop/analysis/closure authorization, reminder precedence.');
