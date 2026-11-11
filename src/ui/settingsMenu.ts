import type { ExecutionScope } from '../workflow/executionScope.ts';
import type { RecoveryMode } from '../workflow/recovery.ts';
import type { ExecutionMode } from '../workflow/executionMode.ts';
export interface SettingsState {
  enabled: boolean; enforced: boolean; mode: ExecutionMode; source: 'config' | 'omp';
  model: string; limit?: number; timeout: number; recoveryMode?: RecoveryMode; recoveryThreshold?: number; authorization?: ExecutionScope;
}
interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}
/** Built-in OMP dialogs avoid bundling another terminal UI framework. Escape cancels. */
export async function openSettings(ui: MenuUI, get: () => SettingsState, actions: {
  change(patch: Partial<SettingsState>): void;
  ompModels(): string[];
  provider(): Promise<void>;
  save(): void;
}) {
  while (true) {
    const s = get();
    const options = [`Cloud access: ${s.enabled ? 'ON' : 'OFF'}`, `Workflow: ${s.mode}`, `Planning enforcement: ${s.enforced ? 'ON' : 'OFF'}`,
      `Advisor source: ${s.source}`, `Advisor model: ${s.model}`, 'Provider settings',
      `Limits: ${s.limit ?? 'unlimited'} calls; ${s.timeout / 1000}s timeout`, `Recovery: ${s.recoveryMode ?? 'observe'}; threshold ${s.recoveryThreshold ?? 3}`, `Authorization: ${s.authorization ?? 'active'}`, 'Save current choices as defaults', 'Close'];
    const choice = await ui.select('Omni Advisor Settings — arrows + Enter; Esc closes', options);
    if (!choice || choice === 'Close') return;
    const index = options.indexOf(choice);
    if (index === 0) actions.change({ enabled: !s.enabled });
    if (index === 1) {
      const mode = await ui.select('Workflow (cloud-led consults between work batches)', ['Balanced — plan, key decisions, final review (default)', 'Local-led — plan once, execute locally', 'Cloud-led — cloud decides next batch']);
      if (mode) actions.change({ mode: mode.startsWith('Cloud-led') ? 'cloud-led' : mode.startsWith('Balanced') ? 'balanced' : 'local-led' });
    }
    if (index === 2) actions.change({ enforced: !s.enforced });
    if (index === 3) {
      const source = await ui.select('Advisor source', ['OMP instance', 'Configured endpoint']);
      if (source) actions.change({ source: source === 'OMP instance' ? 'omp' : 'config' });
    }
    if (index === 4) {
      if (s.source === 'omp') {
        const models = actions.ompModels();
        if (!models.length) { ui.notify('No available OMP models.', 'warning'); continue; }
        const model = await ui.select('OMP advisor model (executor unchanged)', models);
        if (model && models.includes(model)) actions.change({ model });
      } else {
        const model = await ui.input('Advisor model: provider/model-id', s.model);
        if (model === undefined) continue;
        if (!/^[^/\s]+\/\S+$/.test(model.trim())) ui.notify('Use provider/model-id.', 'error');
        else actions.change({ model: model.trim() });
      }
    }
    if (index === 5) await actions.provider();
    if (index === 6) {
      const limit = await ui.input('Maximum consultations (blank = unlimited)', s.limit?.toString() ?? '');
      if (limit === undefined) continue;
      const n = limit.trim() ? Number(limit) : undefined;
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) { ui.notify('Enter a positive integer or leave blank.', 'error'); continue; }
      const timeout = await ui.input('Request timeout in seconds (1–300)', String(s.timeout / 1000));
      if (timeout === undefined) continue;
      const ms = Number(timeout) * 1000;
      if (!Number.isFinite(ms) || ms < 1000 || ms > 300000) { ui.notify('Timeout must be 1–300 seconds.', 'error'); continue; }
      actions.change({ limit: n, timeout: ms });
    }
    if(index === 8){
      const authorization=await ui.select('Execution authorization for this session', ['active','paused','analysis','closure']);
      if(authorization)actions.change({authorization:authorization as ExecutionScope});
    }
    if (index === 7) {
      const mode=await ui.select('Recovery control', ['disabled','observe','enforce']);
      if (!mode) continue;
      const threshold=await ui.input('Similar failures before recovery (2–20)',String(s.recoveryThreshold ?? 3));
      if(threshold===undefined)continue;
      const n=Number(threshold);
      if(!Number.isInteger(n)||n<2||n>20){ui.notify('Enter an integer from 2 to 20.','error');continue;}
      actions.change({recoveryMode:mode as RecoveryMode,recoveryThreshold:n});
    }
    if (index === 9) {
      try { actions.save(); ui.notify('Defaults saved. Current session choices remain active.', 'info'); }
      catch { ui.notify('Could not save defaults; current session choices remain active.', 'error'); }
    }
  }
}

export async function editProvider(ui: MenuUI, current: Record<string, import('../advisor/advisorDispatch.ts').ProviderConfig>, selected: string) {
  const name = await ui.input('Provider alias (not a key)', selected);
  if (name === undefined) return;
  if (!/^[A-Za-z0-9_-]+$/.test(name.trim())) { ui.notify('Use letters, numbers, underscore or dash.', 'error'); return; }
  const alias = name.trim(), existing = current[alias];
  const baseUrl = await ui.input('HTTPS API base URL (no credentials)', existing?.baseUrl ?? 'https://openrouter.ai/api/v1');
  if (baseUrl === undefined) return;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { ui.notify('Use an HTTPS base URL without credentials, query, or fragment.', 'error'); return; }
  const api = await ui.select('API format', ['OpenAI compatible', 'Anthropic native']);
  if (!api) return;
  const apiKeyEnv = await ui.input('API-key ENVIRONMENT VARIABLE NAME only (blank = no key)', existing?.apiKeyEnv ?? '');
  if (apiKeyEnv === undefined) return;
  if (apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv.trim())) { ui.notify('Enter a variable name, never the actual key.', 'error'); return; }
  const tokens = await ui.input('Maximum output tokens (256–16384)', String(existing?.maxOutputTokens ?? 4096));
  if (tokens === undefined) return;
  const n = Number(tokens);
  if (!Number.isInteger(n) || n < 256 || n > 16384) { ui.notify('Invalid token limit.', 'error'); return; }
  const streaming = await ui.select('Progress signals', ['Streaming phases', 'Buffered (waiting only)']);
  if (!streaming) return;
  return { alias, provider: { baseUrl: baseUrl.trim(), api: api === 'Anthropic native' ? 'anthropic' as const : 'openai' as const,
    ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}), maxOutputTokens: n, stream: streaming === 'Streaming phases' } };
}
