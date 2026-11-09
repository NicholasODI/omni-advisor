import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
/** Preserve unrelated settings and replace the file atomically. Never accepts secret values from UI. */
export function saveSettings(path: string, changes: Record<string, unknown>): void {
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new Error('Invalid configuration');
  const next = { ...disk, ...changes, providers: { ...disk.providers, ...(changes.providers as object) } };
  const temp = `${path}.tmp-${process.pid}`;
  try { writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* renamed or absent */ } }
}
