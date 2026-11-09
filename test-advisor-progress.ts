import assert from 'node:assert/strict';
import { startAdvisorProgress, type ProgressUpdate } from './advisorProgress.ts';
const updates: ProgressUpdate[] = [];
let now = 1000;
const signal = new AbortController();
const progress = startAdvisorProgress(u => updates.push(u), signal.signal, () => now);
assert.equal(updates[0].details.status, 'waiting');
now = 8000;
progress.stop('completed');
assert.equal(updates[1].details.elapsedSeconds, 7);
assert.equal(updates[1].details.status, 'completed');
signal.abort(); progress.stop('failed');
assert.equal(updates.length, 2);
const aborted = new AbortController(); aborted.abort();
const cancelled: ProgressUpdate[] = [];
startAdvisorProgress(u => cancelled.push(u), aborted.signal).stop('completed');
assert.equal(cancelled.at(-1)?.details.status, 'cancelled');
// Callback exceptions and absent callbacks cannot fail a consultation.
startAdvisorProgress(() => { throw new Error('UI unavailable'); }).stop('failed');
startAdvisorProgress().stop('completed');
// Exercise heartbeat without waiting, and verify terminal cleanup.
const originalSet = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
let heartbeat: (() => void) | undefined; let cleared = false;
globalThis.setInterval = ((fn: () => void) => { heartbeat = fn; return { unref() {} }; }) as any;
globalThis.clearInterval = (() => { cleared = true; }) as any;
try {
  const streamed: ProgressUpdate[] = [];
  const running = startAdvisorProgress(u => streamed.push(u));
  heartbeat!(); assert.equal(streamed.length, 2);
  running.stop('failed'); assert.equal(cleared, true);
  heartbeat!(); assert.equal(streamed.length, 3);
} finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
console.log('Advisor progress tests passed: heartbeat, completion, cancellation, cleanup, optional callback, UI failures.');
