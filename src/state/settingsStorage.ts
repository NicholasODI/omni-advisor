import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
/** Accept UTF-8 BOMs written by Windows editors, but never overwrite invalid JSON. */
export function readSettings(path: string): Record<string, unknown> {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const disk = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new Error('Invalid configuration');
  return disk;
}
/** Preserve unrelated settings and replace the file atomically. Never accepts secret values from UI. */
export function saveSettings(path: string, changes: Record<string, unknown>): void {
  const disk = readSettings(path);
  const next = { ...disk, ...changes, providers: { ...disk.providers, ...(changes.providers as object) } };
  const temp = `${path}.tmp-${process.pid}`;
  try { writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* renamed or absent */ } }
}
