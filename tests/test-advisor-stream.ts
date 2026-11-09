import assert from 'node:assert/strict';
import { readAdvisorStream } from '../src/advisor/advisorStream.ts';
import { dispatchOmpAdvisor } from '../src/advisor/ompAdvisor.ts';
const encode = (events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('');
function response(events: unknown[]) {
  const bytes = new TextEncoder().encode(encode(events));
  return new Response(new ReadableStream({ start(c) { for (let i=0;i<bytes.length;i+=7) c.enqueue(bytes.slice(i,i+7)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const phases: string[] = [];
const result = await readAdvisorStream(response([
  { choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING_NOT_OUTPUT' } }] },
  { choices: [{ delta: { content: 'Plan ✓' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }, '[DONE]',
]), 'openai', p => phases.push(p));
assert.equal(result.text, 'Plan ✓'); assert.deepEqual(phases, ['thinking','answering']); assert.equal(result.usage?.input,10);
assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'),false);
const anthropic = await readAdvisorStream(response([
  { type: 'message_start', message: { usage: { input_tokens: 8 } } },
  { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'NOT_OUTPUT' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Steps' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
]),'anthropic');
assert.equal(anthropic.text,'Steps'); assert.equal(anthropic.usage?.output,4);
await assert.rejects(() => readAdvisorStream(response([{choices:[{delta:{content:'Partial'}}]}]),'openai'),/incomplete/);
await assert.rejects(() => readAdvisorStream(response([{choices:[{finish_reason:'length'}]},'[DONE]']),'openai'),/truncated/);
await assert.rejects(() => readAdvisorStream(response([{error:{message:'private error'}}]),'openai'),/stream failed/);
const ompPhases: string[] = [];
const events = () => ({
  async *[Symbol.asyncIterator]() { yield {type:'thinking_delta',delta:'NOT_OUTPUT'}; yield {type:'text_start'}; },
  result: async () => ({ content:[{type:'text',text:'OMP plan'}],stopReason:'stop' }),
});
const omp = await dispatchOmpAdvisor({getAvailable:()=>[],find:()=>({}),getApiKeyAndHeaders:async()=>({ok:true})},'provider/model','Design a worker',1000,undefined,undefined,undefined,p=>ompPhases.push(p),events);
assert.equal(omp.text,'OMP plan'); assert.deepEqual(ompPhases,['thinking','answering']);
console.log('Stream tests passed: split SSE frames/UTF-8, provider phases, reasoning exclusion, usage, truncation, incomplete streams, OMP events.');
