import type { AdvisorPhase } from '../advisor/advisorStream.ts';
/** Local status only: never includes briefs, credentials, or partial advice. */
export interface ProgressUpdate {
  content: Array<{ type: 'text'; text: string }>;
  details: { status: string; elapsedSeconds: number };
}
export function startAdvisorProgress(update?: (value: ProgressUpdate) => void, signal?: AbortSignal,
  clock = Date.now, intervalMs = 1000) {
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

/** Theme styling stays in the local footer; tool transcripts remain plain text. */
export const phaseColors: Record<string, 'muted' | 'accent' | 'warning' | 'success' | 'error'> = {
  waiting: 'muted', thinking: 'warning', answering: 'accent', completed: 'success', failed: 'error', cancelled: 'warning',
};
export function updateAdvisorFooter(ui: {
  setStatus?: (key: string, text: string | undefined) => void;
  theme?: { fg: (color: any, text: string) => string };
} | undefined, update: ProgressUpdate): void {
  const label = `Advisor: ${update.details.status} (${update.details.elapsedSeconds}s)`;
  try { ui?.setStatus?.('omni-advisor', ui.theme?.fg(phaseColors[update.details.status] ?? 'muted', label) ?? label); }
  catch { /* A missing theme/footer must not affect completion. */ }
}
