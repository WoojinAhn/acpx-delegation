import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProfile, resolveControls } from '../plugins/rescue/scripts/lib/providers.mjs';
import { preference } from '../plugins/rescue/scripts/lib/preferences.mjs';

test('default model path is allowed only for providers that support it', () => {
  assert.equal(getProfile({ provider: 'grok', cwd: '/tmp', model: null, effort: null }).sessionOptions.model, undefined);
  assert.throws(() => getProfile({ provider: 'agy', cwd: '/tmp' }), { code: 'MODEL_REQUIRED' });
  assert.throws(() => getProfile({ provider: 'qoder', cwd: '/tmp' }), { code: 'PROVIDER_UNSUPPORTED' });
  const exact = 'literal,model[high]';
  assert.equal(getProfile({ provider: 'agy', cwd: '/tmp', model: exact }).sessionOptions.model, exact);
});

test('requested controls require exact advertised options before any configuration', () => {
  const profile = getProfile({ provider: 'agy', cwd: '/tmp', model: 'gemini-4-argon', access: 'read-only', effort: 'high' });
  const status = { details: { configOptions: [
    { id: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'plan' }] },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium' }] },
  ] } };
  assert.throws(() => resolveControls(profile, status), { code: 'CONFIG_UNSUPPORTED' });
  status.details.configOptions[1].options.push({ value: 'high' });
  assert.deepEqual(resolveControls(profile, status).map(option => [option.key, option.value]), [['mode', 'plan'], ['thought_level', 'high']]);
});

test('preference reads do not create state and saved model/effort remain provider-scoped', async () => {
  const data = await mkdtemp(join(tmpdir(), 'rescue-preference-'));
  assert.equal((await preference(data, 'agy')).model, null);
  assert.deepEqual(await readdir(data), []);
  await preference(data, 'agy', 'set', 'gemini-4-argon', 'high');
  assert.deepEqual(await preference(data, 'agy'), { ok: true, provider: 'agy', model: 'gemini-4-argon', effort: 'high' });
  assert.equal((await preference(data, 'grok')).model, null);
  await preference(data, 'agy', 'clear');
  assert.equal((await preference(data, 'agy')).model, null);
});
