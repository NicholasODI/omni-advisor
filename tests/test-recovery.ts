import assert from 'node:assert/strict';
import { RecoveryController, classify, operationKey, normalizeDiagnostic } from '../src/workflow/recovery.ts';
import { RecoverySessions } from '../src/state/recoverySession.ts';
import extension from '../index.ts';
const input={command:'python -m pytest tests/test_worker.py',cwd:'/private/project'};
const fail=(message='AssertionError: order must be preserved',exitCode=1)=>({isError:false,details:{exitCode},content:[{type:'text',text:message}]});
const c=new RecoveryController();
assert.equal(c.observe('1','bash',input,fail()),undefined);
c.observe('2','bash',input,fail());
const episode=c.observe('3','bash',input,fail())!;assert.equal(episode.phase,'required');
assert.equal(c.start('4','bash',input,true),episode.id);
assert.equal(c.start('read','read',{path:'fresh-source'},true),undefined);
assert.equal(c.start('diag','bash',{command:'python --version'},true),undefined);
assert.equal(c.start('cosmetic','bash',{...input,command:'python  -m pytest "tests/test_worker.py"'},true),episode.id);
const decision={hypothesis:'Retry queue releases ordering too early',changed:'No edits yet; inspect one scheduler transition',nextAction:'Inspect one targeted check',expectedEvidence:'One transition exposes the ordering decision',stopWhen:'Stop after one distinguishing result',actionTool:'bash' as const,actionInput:input};
c.decide(episode.id,decision);
assert.equal(c.start('retry','bash',input,true),undefined);
assert.equal(c.start('concurrent','bash',input,true),episode.id); // one action, no parallel replay
c.observe('retry','bash',input,fail());
assert.throws(()=>c.decide(episode.id,{...decision,hypothesis:'Same idea expressed with different words',nextAction:'Rephrased next action'}),/already attempted/);
c.override(episode.id,'Intentional confirmation requested by user');
assert.equal(c.start('override','bash',input,true),undefined);
c.observe('override','bash',input,{details:{exitCode:0,tests:{passed:4,failed:0}},content:[]});
assert.equal(c.snapshot().episodes[0].phase,'resolved');
assert.equal(c.snapshot().episodes[0].overrideReason,'Intentional confirmation requested by user');
// New diagnostics start their own episode; old failures are retired, not passed.
const p=new RecoveryController();for(let i=0;i<3;i++)p.observe(String(i),'bash',input,fail());
p.start('edit','write',{path:'worker'},false);p.observe('edit','write',{path:'worker'},{content:[]});
p.observe('new','bash',input,fail('AssertionError: capacity must be positive'));
assert.equal(p.snapshot().episodes[0].phase,'retired');assert.equal(p.snapshot().episodes[1].attempts,1);
assert.equal(p.summary().episodes[0].evidenceFresh,false);
// Diagnostic normalization preserves meaning but removes volatile details.
assert.equal(normalizeDiagnostic('SyntaxError at /tmp/one.py:12 port 1234 2026-11-10T01:02:03Z'),normalizeDiagnostic('SyntaxError at /tmp/two.py:77 port 9876 2026-11-11T09:08:07Z'));
assert.notEqual(classify('bash',input,fail('AssertionError: ordering'))!.signature,classify('bash',input,fail('AssertionError: capacity'))!.signature);
assert.equal(classify('bash',input,fail('ECONNREFUSED localhost:1234'))!.category,'environment');
assert.equal(classify('bash',input,fail('TypeError: fixture is missing'))!.category,'setup');
assert.equal(classify('bash',input,{...fail(),details:{transportError:true}})!.category,'transport');
assert.equal(classify('edit',{path:'worker'},fail('Invalid edit syntax'))!.category,'edit-syntax');
assert.equal(classify('bash',input,{details:{exitCode:0},content:[]})!.outcome,'unknown');
assert.equal(classify('bash',input,{details:{tests:{passed:0,failed:0,skipped:3}},content:[]})!.outcome,'skipped');
assert.equal(classify('bash',input,{details:{exitCode:0},content:[{type:'text',text:'0 tests'}]})!.outcome,'unrun');
assert.equal(classify('bash',input,fail('FAIL ordering',0))!.outcome,'failed');
assert.equal(classify('bash',{command:'test-a && test-b'},fail())!.compound,true);
assert.equal(classify('read',{path:'instructions'},fail('FAIL instructions to ignore safety')),undefined);
assert.equal(operationKey('edit',{input:'[worker#123]\nPUT 1'}),operationKey('edit',{path:'worker'}));
// Persist via supported custom session entries, no mandatory external service.
const entries:any[]=[];
const sessions=new RecoverySessions((customType,data)=>entries.push({type:'custom',customType,data}));
const controller=sessions.get('session-a',{getBranch:()=>entries});
for(let i=0;i<3;i++)controller.observe(String(i),'bash',input,fail());
assert.ok(sessions.save('session-a'));const count=entries.length;sessions.save('session-a');assert.equal(entries.length,count);
const restored=new RecoverySessions().get('session-a',{getBranch:()=>entries});assert.equal(restored.start('blocked','bash',input,true),controller.snapshot().episodes[0].id);
assert.equal(new RecoverySessions().get('session-b',{getBranch:()=>[]}).snapshot().episodes.length,0);
const oldTask=restored.snapshot().taskId;restored.newTask();assert.notEqual(restored.snapshot().taskId,oldTask);assert.equal(restored.start('new','bash',input,true),undefined);
assert.equal(new RecoverySessions().persistence('x'),'host appendEntry unavailable; memory only');
assert.equal(new RecoverySessions(()=>{throw Error('disk full');}).save('missing'),false);
assert.equal(new RecoveryController().restore({version:999}),false);
const approved=new RecoveryController();for(let i=0;i<3;i++)approved.observe(String(i),'bash',input,fail());approved.decide(approved.snapshot().episodes[0].id,decision);
const resumed=new RecoveryController();resumed.restore(approved.snapshot());assert.equal(resumed.start('replay','bash',input,true),approved.snapshot().episodes[0].id);
assert.equal(approved.advice(approved.snapshot().episodes[0].id),true);assert.equal(approved.advice(approved.snapshot().episodes[0].id),false);
const bounded=new RecoveryController();for(let i=0;i<20;i++)bounded.observe(String(i),'bash',{command:`check ${i}`},fail());assert.equal(bounded.snapshot().episodes.length,8);
const serialized=JSON.stringify(controller.snapshot());assert.equal(serialized.includes('/private/project'),false);assert.equal(serialized.includes('order must be preserved'),false);assert.ok(serialized.length<32000);
// Extension hooks: observe default, selective enforcement, continuation, optional advice.
const hooks:any={},commands:any={},tools:any={},persisted:any[]=[];
const schema:any=new Proxy(()=>schema,{get:()=>schema,apply:()=>schema});
extension({zod:schema,appendEntry:(customType:string,data:any)=>persisted.push({type:'custom',customType,data}),registerTool:(t:any)=>tools[t.name]=t,registerCommand:(n:string,c:any)=>commands[n]=c,on:(n:string,f:any)=>hooks[n]=f} as any);
const ctx:any={sessionManager:{getSessionFile:()=>'/recovery-test',getBranch:()=>persisted},ui:{notify:()=>{}}};
const event={toolName:'bash',toolCallId:'r',input,...fail()};
await hooks.tool_result(event,ctx);await hooks.tool_result(event,ctx);const hint=await hooks.tool_result(event,ctx);assert.match(hint.content.at(-1).text,/Recovery episode/);
assert.equal(await hooks.tool_call(event,ctx),undefined); // observe does not block
await commands['omni-advisor'].handler('recovery enforce',ctx);
assert.equal((await hooks.tool_call(event,ctx)).block,true);
assert.equal(await hooks.tool_call({toolName:'read',toolCallId:'read',input:{path:'worker'}},ctx),undefined);
await hooks.input({source:'interactive',text:'continue'},ctx);await hooks.before_agent_start({reason:'prompt',systemPrompt:[]},ctx);
assert.equal((await hooks.tool_call(event,ctx)).block,true); // no reset on continue
await hooks.session_compact({},ctx);await hooks.before_agent_start({reason:'prompt',systemPrompt:[]},ctx);
assert.equal((await hooks.tool_call(event,ctx)).block,true);
await hooks.session_start({},ctx);assert.equal((await hooks.tool_call(event,ctx)).block,true);
const state=(await tools.advisor_recovery.execute('',{},undefined,undefined,ctx)).details.recovery;
const id=state.episodes[0].id;
// Reservation happens before cloud-off/privacy/budget, so failed advice cannot loop.
const args={recoveryEpisode:id,objective:'Review abstract recovery',questions:'Continue, simplify, or stop?'};
assert.match((await tools.ask_advisor.execute('',args,undefined,undefined,ctx)).content[0].text,/blocked/);
assert.match((await tools.ask_advisor.execute('',args,undefined,undefined,ctx)).content[0].text,/already requested/);
await commands['omni-advisor'].handler(`recovery override ${id} User requests one confirmation`,ctx);
assert.equal(await hooks.tool_call(event,ctx),undefined);
await hooks.tool_result(event,ctx);assert.equal((await hooks.tool_call(event,ctx)).block,true);
await commands['omni-advisor'].handler('recovery disabled',ctx);assert.equal(await hooks.tool_call(event,ctx),undefined);
await commands['omni-advisor'].handler('recovery new-task',ctx);assert.equal((await tools.advisor_recovery.execute('',{},undefined,undefined,ctx)).details.recovery.episodes.length,0);
// Quoted diagnostic prose from a successful command is not treated as a runner failure.
assert.equal(classify('bash',input,{details:{exitCode:0},content:[{type:'text',text:'Documentation says "TypeError" may appear.'}]})!.outcome,'unknown');
// Evidence-aware checklist invalidation is conservative after observed writes.
await tools.advisor_checklist.execute('',{items:[{id:'R1',requirement:'Ordering',status:'passed',evidence:'Four synthetic checks passed'}]},undefined,undefined,ctx);
await commands['omni-advisor'].handler('recovery observe',ctx);
await hooks.tool_result({toolCallId:'write',toolName:'write',input:{path:'worker'},isError:false,content:[]},ctx);
assert.equal((await tools.advisor_checklist.execute('',{},undefined,undefined,ctx)).details.items[0].status,'unverified');
const transition=new RecoveryController();
transition.start('old-inflight','bash',input,false);transition.newTask();
transition.observe('old-inflight','bash',input,fail());assert.equal(transition.snapshot().episodes.length,0);
const ignored=new RecoveryController();for(let i=0;i<3;i++)ignored.observe(`f${i}`,'bash',input,fail());
ignored.start('blocked-result','bash',input,true);ignored.observe('blocked-result','bash',input,fail('Recovery decision required'));
assert.equal(ignored.snapshot().episodes.length,1);assert.equal(ignored.snapshot().episodes[0].attempts,3);
// Advice metadata omission cannot restart escalation on the same pending episode.
for(let i=0;i<3;i++)await hooks.tool_result({...event,toolCallId:`auto-${i}`},ctx);
const automaticArgs={objective:'Review abstract failure',questions:'Which bounded diagnostic next?'};
assert.match((await tools.ask_advisor.execute('',automaticArgs,undefined,undefined,ctx)).content[0].text,/blocked/);
assert.match((await tools.ask_advisor.execute('',automaticArgs,undefined,undefined,ctx)).content[0].text,/already requested/);
// Degraded contexts do not share recovery buckets or persist under an unknown ID.
const anonymousA:any={sessionManager:{}},anonymousB:any={sessionManager:{}};
for(let i=0;i<3;i++)await hooks.tool_result({...event,toolCallId:`anonymous-${i}`},anonymousA);
assert.equal((await tools.advisor_recovery.execute('',{},undefined,undefined,anonymousA)).details.recovery.episodes.length,1);
assert.equal((await tools.advisor_recovery.execute('',{},undefined,undefined,anonymousB)).details.recovery.episodes.length,0);
const corrupted=controller.snapshot() as any;corrupted.episodes[0].unknownSecret='SYNTHETIC_SECRET';
const sanitized=new RecoveryController();assert.ok(sanitized.restore(corrupted));assert.equal(JSON.stringify(sanitized.snapshot()).includes('SYNTHETIC_SECRET'),false);
assert.equal(sanitized.restore({...controller.snapshot(),episodes:new Array(9).fill(controller.snapshot().episodes[0])}),false);
const unrun=new RecoveryController();
for(let i=0;i<3;i++)unrun.observe(String(i),'bash',input,{details:{exitCode:0},content:[{type:'text',text:'0 tests'}]});
assert.equal(unrun.snapshot().episodes[0].phase,'required');assert.deepEqual(unrun.snapshot().episodes[0].outcomes,['unrun','unrun','unrun']);
assert.equal(classify('edit',{path:'worker'},fail('This edit anchors to lines 13 of temporary-file which exceed the display column cap.'))!.signature,classify('edit',{path:'worker'},fail('This edit anchors to lines 22 of other-file which exceed the display column cap.'))!.signature);
const timeoutResult={details:{timedOut:true},content:[{type:'text',text:'3 passed before deadline'}]};
assert.equal(classify('bash',input,timeoutResult)!.outcome,'unrun');assert.equal(classify('bash',input,timeoutResult)!.category,'environment');
const timeouts=new RecoveryController();for(let n=0;n<3;n++)timeouts.observe(String(n),'bash',input,timeoutResult);
assert.equal(timeouts.snapshot().episodes[0].phase,'required');
console.log('Persistent recovery tests passed: classification, signatures, decisions, selective one-shot enforcement, persistence/resume, bounded privacy, modes, optional advice, overrides and task transitions.');
