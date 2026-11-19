import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as acpx from 'acpx/runtime';
import { createExecutionService } from '../plugins/rescue/scripts/lib/executions.mjs';
import { freshSubmitter, sessionConfigurator } from '../plugins/rescue/scripts/lib/providers.mjs';

const agentPath = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
const serviceUrl = new URL('../plugins/rescue/scripts/lib/executions.mjs', import.meta.url).href;
const runtimeUrl = import.meta.resolve('acpx/runtime');
const cliPath = fileURLToPath(new URL('./cli.js', runtimeUrl));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rescue-execution-'));
  const cwd = directory;
  const dataDir = join(directory, 'integration');
  const agentData = join(directory, 'agent');
  const receipts = [];
  let configured = 0;
  let submitted = 0;
  let prepared;
  const getProfile = ({ model, access, effort }) => ({
    agent: 'rescue-test-fixture', argv: [process.execPath, agentPath, agentData, ...(options.fixtureMode ? [options.fixtureMode] : [])],
    permissionMode: access === 'read-only' ? 'approve-reads' : 'approve-all',
    sessionOptions: model ? { model } : undefined,
    ...(options.freshViaCli ? { freshViaCli: true } : {}),
    configOptions: options.controls ? [
      { key: 'mode', value: access === 'read-only' ? 'ask' : 'accept-edits' },
      ...(effort ? [{ category: 'thought_level', value: effort }] : []),
    ] : [],
  });
  const ttlMs = options.ttlMs ?? 30_000;
  const service = createExecutionService({ dataDir, acpx, getProfile, ttlMs,
    configureSession: async input => { configured += 1; await sessionConfigurator(cliPath)(input); },
    submitFresh: options.freshViaCli ? async input => {
      submitted += 1;
      const names = await readdir(join(dataDir, 'executions'));
      const candidates = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(dataDir, 'executions', name), 'utf8'))));
      prepared = candidates.find(receipt => receipt.handle?.acpxRecordId === input.handle.acpxRecordId);
      const ack = await freshSubmitter(cliPath)(input);
      if (options.ack === 'throw') throw new Error('Lost acknowledgement after CLI dispatch');
      if (options.ack === 'missing') return undefined;
      if (options.ack === 'wrong-record') return { ...ack, acpxRecordId: 'not-this-record' };
      return ack;
    } : undefined,
  });
  const start = async input => {
    const result = await service.start({ provider: 'grok', cwd, prompt: 'hello', model: 'fixture-a', ...input });
    receipts.push(result);
    return result;
  };
  t.after(async () => {
    const handled = new Set();
    for (const receipt of receipts.reverse()) {
      if (!receipt.handle || handled.has(receipt.handle.acpxRecordId)) continue;
      handled.add(receipt.handle.acpxRecordId);
      const runtime = acpx.createSharedAcpRuntime({ cwd,
        agentRegistry: acpx.createAgentRegistry({ overrides: { [receipt.profile.agent]: receipt.profile.argv } }),
        permissionMode: 'deny-all', authPolicy: 'skip',
      });
      try { await runtime.close({ handle: receipt.handle, reason: 'Owned test fixture cleanup' }); }
      finally { await runtime.shutdown(); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const observe = (receipt, timeoutMs = 5000) => service.observe({ id: receipt.id, cwd, timeoutMs });
  const calls = async () => {
    try { return (await readFile(join(agentData, 'calls.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { directory, cwd, dataDir, agentData, getProfile, service, start, observe, calls,
    configured: () => configured, submitted: () => submitted, prepared: () => prepared };
}

test('real shared runtime keeps request-correlated results across fresh and resumed turns', async t => {
  const f = await fixture(t);
  const first = await f.start({ prompt: 'first answer' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.submission.stage, 'accepted');
  assert.notEqual(first.id, first.requestId);
  assert.equal(first.reportedModel, 'fixture-a');
  const firstResult = await f.observe(first);
  assert.equal(firstResult.observation, 'terminal', JSON.stringify(firstResult));
  assert.equal(firstResult.result.status, 'completed');
  assert.match(firstResult.report, /turn=1;model=fixture-a;first answer/);
  const candidate = await f.service.resumeCandidate({ provider: 'grok', cwd: f.cwd });
  assert.equal(candidate.receipt.id, first.id);

  const second = await f.start({ resumeId: first.id, prompt: 'second answer' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.handle.backendSessionId, first.handle.backendSessionId);
  assert.equal(second.handle.acpxRecordId, first.handle.acpxRecordId);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.sequence, 2);
  assert.equal(f.configured(), 1, 'continuation does not reconfigure the session');
  const secondResult = await f.observe(second);
  assert.equal(secondResult.observation, 'terminal', JSON.stringify(secondResult));
  assert.equal(secondResult.result.status, 'completed', JSON.stringify(secondResult));
  assert.match(secondResult.report, /turn=2;model=fixture-a;second answer/);
  const recoveredFirst = await f.observe(first);
  assert.equal(recoveredFirst.report, firstResult.report);
  assert.doesNotMatch(recoveredFirst.report, /second answer/);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'executions', `${second.id}.json`), 'utf8'));
  assert.equal(persisted.requestId, second.requestId);
  assert.equal(Object.hasOwn(persisted, 'report'), false);
  assert.equal(Object.hasOwn(persisted, 'prompt'), false);
});

test('passive observation expires without cancelling, and another process recovers the result', async t => {
  const f = await fixture(t);
  const receipt = await f.start({ prompt: 'delay:1800\nrecover me' });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const pending = await f.observe(receipt, 60);
  assert.equal(pending.observation, 'pending', JSON.stringify(pending));
  const path = join(f.dataDir, 'executions', `${receipt.id}.json`);
  await writeFile(path, JSON.stringify({ ...receipt, observationDeadline: Date.now() - 1 }));
  const expired = await f.observe(receipt, 60);
  assert.equal(expired.observation, 'expired', JSON.stringify(expired));
  // acpx journals turn_result after the agent delay and its reply-idle drain.
  // An expired deadline only inspects briefly, so wait until that result is durable.
  const deadline = Date.now() + 20_000;
  let settled;
  do {
    const timeoutMs = Math.max(1, Math.min(1_000, deadline - Date.now()));
    settled = await f.service.observe({ id: receipt.id, cwd: f.cwd, timeoutMs, enforceDeadline: false });
  } while (settled.observation !== 'terminal' && Date.now() < deadline);
  assert.equal(settled.observation, 'terminal', JSON.stringify(settled));
  assert.equal(settled.result?.status, 'completed', JSON.stringify(settled));
  const source = `
    import * as acpx from ${JSON.stringify(runtimeUrl)};
    import { createExecutionService } from ${JSON.stringify(serviceUrl)};
    const service = createExecutionService({dataDir:${JSON.stringify(f.dataDir)},acpx,getProfile(){throw new Error('recovery must not launch');}});
    console.log(JSON.stringify(await service.observe({id:${JSON.stringify(receipt.id)},cwd:${JSON.stringify(f.cwd)},timeoutMs:5000})));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  const recovered = JSON.parse(output);
  assert.equal(recovered.result?.status, 'completed', JSON.stringify(recovered));
  assert.match(recovered.report, /recover me/);
  assert.equal((await f.calls()).filter(call => call.method === 'session/cancel').length, 0);
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
});

test('explicit cancellation settles the target and old cancellation cannot affect a follow-up', async t => {
  const f = await fixture(t);
  const first = await f.start({ prompt: 'delay:5000\nfirst long task' });
  const cancelled = await f.service.cancel({ id: first.id, cwd: f.cwd });
  assert.ok(['requested', 'confirmed'].includes(cancelled.cancellation), JSON.stringify(cancelled));
  assert.equal((await f.observe(first)).result.status, 'cancelled');
  const second = await f.start({ resumeId: first.id, prompt: 'delay:1600\nsecond must finish' });
  assert.equal(second.ok, true, JSON.stringify(second));
  const old = await f.service.cancel({ id: first.id, cwd: f.cwd });
  assert.equal(old.cancellation, 'not-needed');
  const completed = await f.observe(second);
  assert.equal(completed.result.status, 'completed');
  assert.match(completed.report, /second must finish/);
  assert.equal((await f.calls()).filter(call => call.method === 'session/cancel').length, 1);
});

test('duplicate continuation is rejected and model/access/effort cannot change on resume', async t => {
  const f = await fixture(t);
  const first = await f.start({ prompt: 'starting point', access: 'read-only' });
  await f.observe(first);
  for (const change of [{ access: 'write' }, { model: 'fixture-b' }, { effort: 'high' }]) {
    await assert.rejects(f.start({ resumeId: first.id, ...change }), { code: 'SESSION_CHOICE_MISMATCH' });
  }
  const attempts = await Promise.allSettled([
    f.start({ resumeId: first.id, access: undefined, prompt: 'delay:2000\nfollow A' }),
    f.start({ resumeId: first.id, access: undefined, prompt: 'delay:2000\nfollow B' }),
  ]);
  const successful = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(successful.length, 1, JSON.stringify(attempts));
  assert.equal(successful[0].value.ok, true);
  assert.equal(successful[0].value.access, 'read-only');
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'SESSION_BUSY');
  await assert.rejects(f.start({ resumeId: first.id, access: undefined }), { code: 'SUPERSEDED_EXECUTION' });
  await assert.rejects(f.start({ resumeId: successful[0].value.id, access: undefined }), { code: 'SESSION_UNSETTLED' });
  await f.observe(successful[0].value);
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 2);
});

test('cold invalid native resume never creates a replacement or sends a new prompt', async t => {
  const f = await fixture(t, { ttlMs: 100 });
  const first = await f.start({ prompt: 'only prompt' });
  await f.observe(first);
  await sleep(500);
  await rm(join(f.agentData, `${first.handle.backendSessionId}.json`));
  const resumed = await f.start({ resumeId: first.id, prompt: 'must not be submitted' });
  assert.equal(resumed.ok, false, JSON.stringify(resumed));
  const result = await f.observe(resumed);
  assert.ok(['terminal', 'unknown'].includes(result.observation), JSON.stringify(result));
  const calls = await f.calls();
  assert.equal(calls.filter(call => call.method === 'session/new').length, 1);
  assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1);
});

test('unsupported exact model stops before a prompt, without fallback', async t => {
  const f = await fixture(t);
  const receipt = await f.start({ model: 'not-a-fixture-model' });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.submission.stage, 'failed');
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 0);
});

test('continuation refuses an intervening upstream request outside integration receipts', async t => {
  const f = await fixture(t);
  const first = await f.start({ prompt: 'integration first' });
  await f.observe(first);
  const runtime = acpx.createSharedAcpRuntime({ cwd: first.cwd,
    agentRegistry: acpx.createAgentRegistry({ overrides: { [first.profile.agent]: first.profile.argv } }),
    permissionMode: 'approve-all', authPolicy: 'skip',
  });
  const turn = runtime.startTurn({ handle: first.handle, requestId: 'outside-integration', mode: 'prompt', text: 'direct upstream turn' });
  try {
    await turn.promptStarted;
    assert.equal((await turn.result).status, 'completed');
  } finally { await turn.closeStream(); await runtime.shutdown(); }
  const resumed = await f.start({ resumeId: first.id, prompt: 'do not send this' });
  assert.equal(resumed.ok, false, JSON.stringify(resumed));
  assert.equal(resumed.submission.error.code, 'RESUME_MISS');
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 2);
});

test('owner failure and malformed receipts are explicit and never trigger resubmission', async t => {
  const f = await fixture(t);
  const receipt = await f.start({ prompt: 'crash-after-submit' });
  const observed = await f.observe(receipt);
  assert.ok(observed.observation === 'unknown' || observed.result?.status === 'failed', JSON.stringify(observed));
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
  const path = join(f.dataDir, 'executions', `${receipt.id}.json`);
  await writeFile(path, '{incomplete');
  await assert.rejects(f.observe(receipt), { code: 'RECEIPT_UNKNOWN' });
  await assert.rejects(f.service.cancel({ id: receipt.id, cwd: f.cwd }), { code: 'RECEIPT_UNKNOWN' });
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
});

test('receipts remain scoped to cwd and list cannot launch new work', async t => {
  const f = await fixture(t);
  const receipt = await f.start({ prompt: 'list me' });
  await f.observe(receipt);
  const rows = await f.service.list({ cwd: f.cwd, provider: 'grok' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, receipt.id);
  assert.equal(rows[0].result.status, 'completed');
  await assert.rejects(f.service.observe({ id: receipt.id, cwd: tmpdir(), timeoutMs: 50 }), { code: 'CWD_MISMATCH' });
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
  assert.equal((await readdir(join(f.dataDir, 'executions'))).filter(name => name.endsWith('.tmp')).length, 0);
});

test('status exposes malformed receipt IDs while mutations remain conservative about unknown scope', async t => {
  const f = await fixture(t);
  const active = await f.start({ prompt: 'delay:10000\nkeep this request active' });
  const damaged = await f.start({ prompt: 'receipt to corrupt' });
  await f.observe(damaged);
  await writeFile(join(f.dataDir, 'executions', `${damaged.id}.json`), '{malformed');
  const rows = await f.service.list({ cwd: f.cwd, provider: 'grok' });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === active.id).observation, 'pending');
  assert.deepEqual(Object.fromEntries(['id', 'scope', 'cwd', 'provider', 'observation'].map(key => [key, rows.find(row => row.id === damaged.id)[key]])),
    { id: damaged.id, scope: 'unknown', cwd: null, provider: null, observation: 'unknown' });
  await assert.rejects(f.service.cancel({ id: active.id, cwd: f.cwd }), { code: 'RECEIPT_UNKNOWN' });
  await assert.rejects(f.start({ resumeId: active.id }), { code: 'RECEIPT_UNKNOWN' });
  await assert.rejects(f.service.resumeCandidate({ cwd: f.cwd, provider: 'grok' }), { code: 'RECEIPT_UNKNOWN' });
  await assert.rejects(f.service.observe({ id: damaged.id, cwd: f.cwd }), { code: 'RECEIPT_UNKNOWN' });
  assert.equal((await f.calls()).filter(call => call.method === 'session/cancel').length, 0);
});

test('fresh CLI bootstrap binds the recovered native identity before strict shared continuation', async t => {
  const f = await fixture(t, { freshViaCli: true, fixtureMode: 'unsaved-empty', controls: true });
  const first = await f.start({ prompt: 'delay:2500\nfirst CLI answer', model: 'fixture-b', access: 'read-only', effort: 'high' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.submission.stage, 'queued');
  assert.equal(first.nativeIdentity, 'provisional');
  assert.equal(f.prepared().requestId, null, 'the durable receipt cannot invent the CLI request ID');
  assert.equal(f.prepared().submission.stage, 'prepared');
  await assert.rejects(f.start({ resumeId: first.id, model: undefined }), { code: 'SESSION_UNSETTLED' });
  const result = await f.observe(first);
  assert.equal(result.result?.status, 'completed', JSON.stringify(result));
  assert.match(result.report, /turn=1;model=fixture-b;.*first CLI answer/s);
  assert.match(result.report, /;mode=ask;effort=high$/);
  assert.equal(result.nativeIdentity, 'bound', JSON.stringify(result));
  assert.equal(result.handle.acpxRecordId, first.handle.acpxRecordId);
  assert.notEqual(result.handle.backendSessionId, first.handle.backendSessionId);
  const candidate = await f.service.resumeCandidate({ provider: 'grok', cwd: f.cwd });
  assert.equal(candidate.available, true, JSON.stringify(candidate));
  assert.equal(candidate.receipt.handle.backendSessionId, result.handle.backendSessionId);
  const second = await f.start({ resumeId: first.id, model: undefined, prompt: 'strict second answer' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.submission.stage, 'accepted');
  assert.equal(second.handle.backendSessionId, result.handle.backendSessionId);
  assert.match((await f.observe(second)).report, /turn=2;model=fixture-b;strict second answer/);
  assert.equal(f.submitted(), 1, 'the CLI exception is only used for the first prompt');
  assert.equal(f.configured(), 1);
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 2);
});

test('missing or mismatched first-submission acknowledgements remain unknown and cannot be resumed or cancelled', async t => {
  for (const ack of ['missing', 'wrong-record', 'throw']) {
    await t.test(ack, async t => {
      const f = await fixture(t, { freshViaCli: true, fixtureMode: 'unsaved-empty', ack });
      const receipt = await f.start({ prompt: 'submitted once despite lost acknowledgement' });
      assert.equal(receipt.ok, false, JSON.stringify(receipt));
      assert.equal(receipt.submission.stage, 'unknown');
      assert.equal(receipt.requestId, null);
      assert.equal((await f.observe(receipt)).observation, 'unknown');
      assert.equal((await f.service.resumeCandidate({ provider: 'grok', cwd: f.cwd })).available, false);
      await assert.rejects(f.service.cancel({ id: receipt.id, cwd: f.cwd }), { code: 'CANCELLATION_UNCERTAIN' });
      await assert.rejects(f.start({ resumeId: receipt.id }), { code: 'SESSION_UNSETTLED' });
      assert.equal(f.submitted(), 1);
      for (let attempt = 0; attempt < 50 && !(await f.calls()).some(call => call.method === 'session/prompt'); attempt += 1) await sleep(50);
      assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
    });
  }
});

test('queued first request can be cancelled while its native identity is provisional', async t => {
  const f = await fixture(t, { freshViaCli: true, fixtureMode: 'unsaved-empty' });
  const first = await f.start({ prompt: 'delay:5000\ncancel bootstrap' });
  assert.equal(first.submission.stage, 'queued', JSON.stringify(first));
  const cancelled = await f.service.cancel({ id: first.id, cwd: f.cwd });
  assert.ok(['requested', 'confirmed'].includes(cancelled.cancellation), JSON.stringify(cancelled));
  const result = await f.observe(first);
  assert.equal(result.result?.status, 'cancelled', JSON.stringify(result));
  assert.equal(result.nativeIdentity, 'bound');
  const second = await f.start({ resumeId: first.id, prompt: 'delay:1500\nafter bootstrap cancellation' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await f.service.cancel({ id: first.id, cwd: f.cwd })).cancellation, 'not-needed');
  assert.equal((await f.observe(second)).result?.status, 'completed');
  assert.equal((await f.calls()).filter(call => call.method === 'session/cancel').length, 1);
});

test('a terminal bootstrap result survives a final identity/model binding failure', async t => {
  const f = await fixture(t, { freshViaCli: true, fixtureMode: 'unsaved-empty' });
  const first = await f.start({ prompt: 'preserve this completed result' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const runtime = acpx.createSharedAcpRuntime({ cwd: first.cwd,
    agentRegistry: acpx.createAgentRegistry({ overrides: { [first.profile.agent]: first.profile.argv } }),
    permissionMode: 'approve-all', authPolicy: 'skip',
  });
  try {
    for await (const event of runtime.watchSession({ handle: first.handle })) {
      if (event.type === 'turn_result' && event.requestId === first.requestId) break;
    }
    await runtime.setModel({ handle: first.handle, model: 'fixture-b' });
  } finally { await runtime.shutdown(); }
  const result = await f.observe(first);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result?.status, 'completed');
  assert.match(result.report, /preserve this completed result/);
  assert.equal(result.nativeIdentity, 'provisional');
  assert.equal(result.continuationAvailable, false);
  assert.equal(result.bindingError.code, 'MODEL_UNVERIFIED');
  assert.equal((await f.service.resumeCandidate({ provider: 'grok', cwd: f.cwd, id: first.id })).available, false);
  await assert.rejects(f.start({ resumeId: first.id }), { code: 'SESSION_UNSETTLED' });
  assert.equal((await f.service.cancel({ id: first.id, cwd: f.cwd })).cancellation, 'not-needed');
  assert.equal((await f.calls()).filter(call => call.method === 'session/prompt').length, 1);
});

test('result retrieval can observe past the worker deadline without cancelling upstream work', async t => {
  const f = await fixture(t);
  const receipt = await f.start({ prompt: 'delay:1800\nfinish beyond expired observation' });
  await writeFile(join(f.dataDir, 'executions', `${receipt.id}.json`), JSON.stringify({ ...receipt, observationDeadline: Date.now() - 1 }));
  const result = await f.service.observe({ id: receipt.id, cwd: f.cwd, timeoutMs: 5000, enforceDeadline: false });
  assert.equal(result.result?.status, 'completed', JSON.stringify(result));
  assert.match(result.report, /finish beyond expired observation/);
  assert.equal((await f.calls()).filter(call => call.method === 'session/cancel').length, 0);
});

test('the finite setup budget aborts a non-responsive agent and returns after owned cleanup', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { fixtureMode: 'hang-initialize' });
  const receipt = await f.start({ prompt: 'never send this' });
  // The test deadline includes upstream process cleanup after the 30s submission budget.
  assert.equal(receipt.ok, false);
  assert.equal(receipt.submission.stage, 'failed');
  assert.equal(receipt.submission.error.code, 'SUBMISSION_TIMEOUT');
  const calls = await f.calls();
  assert.equal(calls.filter(call => call.method === 'session/prompt').length, 0);
  const pid = calls.find(call => call.method === 'initialize').pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the owned stalled fixture process must be gone');
});
