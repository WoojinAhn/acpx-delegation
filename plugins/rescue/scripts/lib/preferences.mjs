import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDERS } from './providers.mjs';

export async function preference(dataDir, provider, action = 'show', model, effort) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider.');
  const dir = join(dataDir, 'preferences');
  const path = join(dir, `${provider}.json`);
  if (action === 'show') {
    try { const saved = JSON.parse(await readFile(path, 'utf8')); return { ok: true, provider, model: saved.model, effort: saved.effort ?? null }; }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, provider, model: null }; throw error; }
  }
  if (action === 'clear') {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { ok: true, provider, model: null };
  }
  if (action !== 'set' || typeof model !== 'string' || !model.trim()) throw new Error('Use preference PROVIDER show|set MODEL|clear.');
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Unsupported reasoning effort.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ model, ...(effort ? { effort } : {}) }) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
  return { ok: true, provider, model, effort: effort ?? null };
}
