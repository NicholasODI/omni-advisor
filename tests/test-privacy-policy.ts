import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateBrief, assertAbstract } from '../src/privacy/planning.ts';
import { dispatchIsolatedAdvisor } from '../src/advisor/advisorDispatch.ts';
import { dispatchOmpAdvisor } from '../src/advisor/ompAdvisor.ts';
import { mask, registerTerms, clearSession } from '../src/privacy/cipher.ts';
import { LOG_DIR, safeSessionId } from '../src/state/logger.ts';
import { executionInstructions } from '../src/workflow/executionMode.ts';
import { advisorBlock, toolResponseFrame } from '../src/advisor/cloudAdvisor.ts';
const brief = { purpose:'decision' as const, objective:'Choose an event-processing design', questions:'Which retry approach preserves ordering?',
  components:'Component A consumes events and updates store B; component C reads B.',
  invariants:'One effect per event; a cancelled handler retains its slot until it exits.',
  alternatives:'Serialize each resource or use optimistic concurrency with idempotency.',
  constraints:'Single process; hundreds of requests per second; persistence required.',
  outcomes:[{check:'Retry ordering',status:'failed' as const,summary:'A later synthetic event overtook a retry.'}] };
const text = validateBrief(brief);
assert.match(text,/One effect per event/); assert.match(text,/later synthetic event/);
assertAbstract('states: queued/running/succeeded/failed/cancelled');
const unsafe = [
 'person@example.org', '10.1.2.3', 'database.internal', 'H:\\Private\\records.txt', '/srv/customer/records.csv', '../private/data',
 'Bearer not_a_real_token', 'client_secret=synthetic_only', 'Cookie: session=synthetic',
 'sk-test_0123456789abcdefghijklmnop', 'const records = [{name: value}]', 'function loadRecords() { return data; }',
 '{"customer":"synthetic"}', '<record>synthetic</record>', 'Traceback (most recent call last)',
];
let networkCalls=0, authCalls=0;
const original=globalThis.fetch;
globalThis.fetch=async()=>{networkCalls++;throw Error('must not dispatch');};
try {
  for (const value of unsafe) {
    for (const field of ['objective','questions','facts','invariants','alternatives','previousPlan']) {
      let error=''; try { validateBrief({...brief,[field]:value}); } catch(e) {error=String(e);}
      assert.match(error,new RegExp(`field ${field}:`)); assert.equal(error.includes(value),false);
    }
    assert.throws(()=>validateBrief({...brief,outcomes:[{check:'Check',status:'failed',summary:value}]}));
    const config={test:{baseUrl:'https://example.com/v1',api:'openai' as const}};
    assert.equal((await dispatchIsolatedAdvisor('test/model',value,1000,undefined,config)).ok,false);
    assert.equal((await dispatchIsolatedAdvisor('test/model','Plan a worker',1000,value,config)).ok,false);
    assert.equal((await dispatchOmpAdvisor({find:()=>({}),getAvailable:()=>[],getApiKeyAndHeaders:async()=>{authCalls++;return {ok:true};}},'test/model',value,1000)).ok,false);
  }
  assert.equal(networkCalls,0); assert.equal(authCalls,0);
} finally {globalThis.fetch=original;}
const sid=`privacy-memory-${Date.now()}`;
registerTerms(sid,[{raw:'synthetic-private-project',type:'WORKSPACE'}]);
assert.notEqual(mask('synthetic-private-project',sid),'synthetic-private-project');
assert.equal(existsSync(join(LOG_DIR,safeSessionId(sid)+'.cipher.json')),false);
clearSession(sid);
assert.match(executionInstructions('balanced'),/final abstract review/);
assert.match(advisorBlock(),/only abstract architecture/);
assert.match(toolResponseFrame('Advice'),/one final abstract review/);
assert.match(toolResponseFrame('Advice','balanced','review'),/Do not request another review/);
console.log('Privacy policy tests passed: structural context retained, sensitive fields/focus/outcomes blocked before network/auth, memory-only mappings, balanced review.');
