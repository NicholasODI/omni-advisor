import assert from 'node:assert/strict';
import { RecoveryGuard } from './recovery.ts';
import extension from './index.ts';
const guard = new RecoveryGuard();
assert.equal(guard.observe('eval',{},true),false);
assert.equal(guard.observe('read',{path:'page'},false),false);
assert.equal(guard.observe('bash',{},true),false);
assert.equal(guard.observe('edit',{path:'harness'},false),false);
assert.equal(guard.observe('eval',{},true),true);
assert.equal(guard.observe('bash',{},true),false); // one hint, not a consultation loop
// Unrelated file errors are not grouped.
guard.reset();
assert.equal(guard.observe('edit',{path:'a'},true),false);
assert.equal(guard.observe('edit',{path:'b'},true),false);
assert.equal(guard.observe('edit',{input:'[a#123]\nPUT 1'},true),false);
assert.equal(guard.observe('edit',{path:'a'},true),true);
const hooks:any = {};
const schema:any = new Proxy(()=>schema,{get:()=>schema,apply:()=>schema});
extension({zod:schema,registerTool:()=>{},registerCommand:()=>{},on:(name:string,fn:any)=>hooks[name]=fn} as any);
const ctx:any={sessionManager:{getSessionFile:()=>'/test/recovery'}};
const failed = (toolName:string) => hooks.tool_result({toolCallId:'test',toolName,input:{},isError:true,content:[{type:'text',text:'original error'}]},ctx);
await failed('eval'); await failed('bash');
await hooks.tool_result({toolCallId:'read',toolName:'read',input:{},isError:false,content:[]},ctx);
const result=await failed('eval');
assert.equal(result.content[0].text,'original error');
assert.match(result.content[1].text,/continue, simplify verification, or stop/);
assert.equal(await failed('eval'),undefined);
// Compaction retains the one-hint state; new user task resets it.
await hooks.session_compact({},ctx);
await hooks.before_agent_start({reason:'prompt',systemPrompt:[]},ctx);
assert.equal(await failed('eval'),undefined);
await hooks.input({source:'interactive'},ctx);
await hooks.before_agent_start({reason:'prompt',systemPrompt:[]},ctx);
await failed('eval'); await failed('eval'); assert.ok(await failed('eval'));
console.log('Recovery tests passed: mixed runners, intervening reads, file grouping, one hint per task, original errors preserved, compaction and new-task lifecycle.');
