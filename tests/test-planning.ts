import assert from 'node:assert/strict';
import { dispatchIsolatedAdvisor } from '../src/advisor/advisorDispatch.ts';
import { assertAbstract, validateBrief } from '../src/privacy/planning.ts';
import extension from '../index.ts';
let calls = 0;
let payload: any;
let request: any;
const original = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  calls++; request = { url: String(_url), ...options }; payload = JSON.parse(String(options?.body));
  return new Response(JSON.stringify(payload.system
    ? { content: [{ type: 'text', text: 'Plan' }], usage: { input_tokens: 10, output_tokens: 20 } }
    : { choices: [{ message: { content: 'Plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
};
try {
  const providers = { example: { baseUrl: 'https://example.com/v1', api: 'openai' as const } };
  let result = await dispatchIsolatedAdvisor('example/model', 'objective: Design an idempotent worker', 1000, undefined, providers);
  assert.equal(result.ok, true); assert.equal(payload.messages.length, 2); assert.equal(payload.tools, undefined);
  assert.match(payload.messages[0].content, /BALANCED PLAN:.*up to three assumptions.*likely outcome/);
  assert.deepEqual(result.usage, { input: 10, output: 20 }); assert.equal(request.redirect, 'error');
  const review = {
    purpose: 'review' as const,
    objective: 'Review retry guarantees',
    questions: 'What is the biggest acceptance gap?',
    outcomes: [{ check: 'Concurrent retries', status: 'unverified' as const, summary: 'Only single-worker retries were checked.' }],
  };
  result = await dispatchIsolatedAdvisor(
    'example/model', validateBrief(review), 1000, undefined,
    { example: { ...providers.example, api: 'anthropic' } }, undefined, undefined, 'balanced', review.purpose,
  );
  assert.equal(result.ok, true); assert.equal(payload.messages.length, 1);
  assert.match(payload.system, /BALANCED FINAL REVIEW:.*most consequential gap/);
  assert.doesNotMatch(payload.system, /ordered steps/i);
  assert.match(payload.messages[0].content, /Concurrent retries: unverified/);
  assert.equal(request.headers['anthropic-version'], '2023-06-01'); assert.match(request.url, /\/v1\/messages$/);
  const before = calls;
  for (const text of ['password: secret', '```code```', '/workspace/private/file', 'https://internal.example']) {
    assert.throws(() => assertAbstract(text));
    assert.equal((await dispatchIsolatedAdvisor('example/model', text, 1000, undefined, providers)).ok, false);
  }
  assert.equal((await dispatchIsolatedAdvisor('example/model', 'Plan a worker', 1000, 'api_key=secret', providers)).ok, false);
  assert.equal((await dispatchIsolatedAdvisor('example/model', 'Plan a worker', 1000, undefined, { example: { baseUrl: 'http://example.com', api: 'openai' } })).ok, false);
  assert.equal(calls, before);
  const tools: any[] = []; const commands: any[] = [];
  const schema: any = new Proxy(() => schema, { get: () => schema, apply: () => schema });
  extension({ zod: schema, registerTool: (t: any) => tools.push(t), registerCommand: (name: string, t: any) => commands.push({ name, ...t }), on: () => {} } as any);
  const ctx: any = { sessionManager: { getSessionFile: () => '/tmp/planning-test-session' }, ui: { notify: () => {} } };
  const args = { objective: 'Design worker', questions: 'Which invariants?' };
  const blocked = await tools[0].execute('', args, undefined, undefined, ctx);
  assert.match(blocked.content[0].text, /blocked/); assert.equal(calls, before);
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_url, opts) => { opts?.signal?.throwIfAborted(); throw new Error('unexpected'); };
  result = await dispatchIsolatedAdvisor('example/model', 'Plan worker', 1000, undefined, providers, controller.signal);
  assert.equal(result.error, 'Consultation cancelled.');
  console.log('Planning boundary tests passed: OpenAI/Anthropic payloads, usage, privacy, gate, HTTPS, cancellation.');
} finally { globalThis.fetch = original; }
