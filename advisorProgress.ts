import type { AdvisorPhase } from './advisorStream.ts';
/** Local status only: never includes briefs, credentials, or partial advice. */
export interface ProgressUpdate {
  content: Array<{ type: 'text'; text: string }>;
  details: { status: string; elapsedSeconds: number };
}
export function startAdvisorProgress(update?: (value: ProgressUpdate) => void, signal?: AbortSignal,
  clock = Date.now, intervalMs = 5000) {
  const started = clock();
  let stopped = false;
  let current: 'waiting' | AdvisorPhase = 'waiting';
  const label = () => current === 'thinking' ? 'Cloud advisor is thinking (provider signal)' : current === 'answering' ? 'Cloud advisor is answering' : 'Still waiting for cloud advisor; no response completed yet';
  const emit = (status: string, label: string) => {
    if (stopped) return;
    const elapsedSeconds = Math.floor((clock() - started) / 1000);
    try { update?.({ content: [{ type: 'text', text: `${label} (${elapsedSeconds}s elapsed)` }], details: { status, elapsedSeconds } }); }
    catch { /* UI failures must not alter consultation or planning approval. */ }
  };
  emit('waiting', 'Brief validated. Waiting for cloud advisor; authentication/network/model processing may take time');
  const timer = update ? setInterval(() => emit(current, label()), intervalMs) : undefined;
  timer?.unref();
  const stop = (status: 'completed' | 'failed' | 'cancelled') => {
    if (stopped) return;
    if (timer) clearInterval(timer);
    signal?.removeEventListener('abort', cancel);
    emit(status, status === 'completed' ? 'Cloud plan received' : status === 'cancelled' ? 'Cloud consultation cancelled' : 'Cloud consultation ended without a plan');
    stopped = true;
  };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return { stop, phase(value: AdvisorPhase) {
    if (value === current || stopped) return;
    current = value; emit(current, label());
  } };
}
