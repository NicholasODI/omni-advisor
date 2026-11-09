import assert from 'node:assert/strict';
import { dispatchOmpAdvisor } from './ompAdvisor.ts';
const model = { provider: 'instance', id: 'vendor/model' };
let requests = 0;
const registry = {
  getAvailable: () => [model],
  find: (p: string, id: string) => p === model.provider && id === model.id ? model : undefined,
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-only', headers: { 'x-test': 'header' } }),
};
const complete = async (selected: any, context: any, options: any) => {
  requests++;
  assert.equal(selected, model);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, 'user');
  assert.equal(context.tools, undefined);
  assert.equal(context.messages[0].content.includes('Design worker'), true);
  assert.equal(options.apiKey, 'test-only');
  assert.equal(options.headers['x-test'], 'header');
  assert.equal(options.maxTokens, 4096);
  return { content: [{ type: 'text', text: 'Verify idempotency' }], stopReason: 'stop', usage: { input: 10, output: 5 } };
};
const result = await dispatchOmpAdvisor(registry, 'instance/vendor/model', 'Design worker', 1000, undefined, undefined, complete);
assert.equal(result.ok, true); assert.equal(result.text, 'Verify idempotency'); assert.equal(result.usage?.input, 10);
assert.equal((await dispatchOmpAdvisor(registry, 'missing/model', 'Design worker', 1000, undefined, undefined, complete)).ok, false);
assert.equal((await dispatchOmpAdvisor(registry, 'instance/vendor/model', 'password=private', 1000, undefined, undefined, complete)).ok, false);
assert.equal((await dispatchOmpAdvisor({ ...registry, getApiKeyAndHeaders: async () => ({ ok: false }) }, 'instance/vendor/model', 'Design worker', 1000, undefined, undefined, complete)).ok, false);
const controller = new AbortController(); controller.abort();
assert.equal((await dispatchOmpAdvisor(registry, 'instance/vendor/model', 'Design worker', 1000, undefined, controller.signal, complete)).ok, false);
assert.equal(requests, 1);
console.log('OMP advisor tests passed: isolated context, registry/auth reuse, usage, missing model, privacy, auth failure, cancellation.');
