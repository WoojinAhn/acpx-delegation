import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SETUP_BUDGET_MS = 30_000;
const OBSERVATION_BUDGET_MS = 15 * 60_000;
const INSPECTION_MS = 750;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorData(error) {
  return { code: error?.code ?? 'EXECUTION_ERROR', message: error?.message ?? String(error) };
}

function uncertain(error) {
  return /unknown|uncertain|disconnect|ACK_MISSING|SUBMISSION_TIMEOUT/i.test(JSON.stringify(error));
}

function bounded(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure(code, 'The submission budget expired; inspect this execution before considering another request.')), Math.max(1, milliseconds));
    }),
  ]).finally(() => clearTimeout(timer));
}

function profileCopy(profile) {
  if (!profile || typeof profile.agent !== 'string' || !profile.agent ||
      !Array.isArray(profile.argv) || !profile.argv.length ||
      profile.argv.some(value => typeof value !== 'string' || !value)) {
    throw failure('INVALID_PROFILE', 'The provider must supply an agent name and an argv array.');
  }
  return JSON.parse(JSON.stringify(profile));
}

function sameHandle(actual, expected) {
  return sameLocalHandle(actual, expected) && actual.backendSessionId === expected.backendSessionId;
}

function sameLocalHandle(actual, expected) {
  return actual && expected && actual.acpxRecordId === expected.acpxRecordId &&
    actual.cwd === expected.cwd && actual.sessionKey === expected.sessionKey;
}

function verifyChoices(receipt, status) {
  if (receipt.requestedModel && (status.models?.currentModelId !== receipt.requestedModel ||
      !status.models?.availableModelIds?.includes(receipt.requestedModel))) {
    throw failure('MODEL_UNVERIFIED', 'The connected agent did not confirm the exact requested model.');
  }
  for (const request of receipt.profile.configOptions ?? []) {
    const option = status.details?.configOptions?.find(item => request.key ? item.id === request.key : item.category === request.category);
    if (option?.currentValue !== request.value) {
      throw failure('CONFIG_UNVERIFIED', `The connected agent did not confirm ${request.key ?? request.category}=${request.value}.`);
    }
  }
}

function reportText(message) {
  const update = message?.method === 'session/update' && message.params?.update;
  return update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
    ? update.content.text ?? '' : '';
}

/** Receipts identify upstream work; acpx remains the owner of sessions and results. */
export function createExecutionService({ dataDir, acpx, getProfile, configureSession, submitFresh, ttlMs = 300_000 }) {
  const base = resolve(dataDir);
  const receiptsDir = join(base, 'executions');
  const locksDir = join(base, 'locks');

  function receiptPath(id) {
    if (typeof id !== 'string' || !/^exec-[a-f0-9-]{36}$/.test(id)) {
      throw failure('INVALID_EXECUTION_ID', 'Use the exact execution ID from its receipt.');
    }
    return join(receiptsDir, `${id}.json`);
  }

  async function save(receipt) {
    await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    const destination = receiptPath(receipt.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function read(id, cwd) {
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'INVALID_EXECUTION_ID') throw error;
      throw failure('RECEIPT_UNKNOWN', `Execution ${id} has a missing or malformed receipt; do not resubmit it.`);
    }
    const awaitingAck = receipt.requestId === null && receipt.nativeIdentity === 'provisional' &&
      receipt.profile?.freshViaCli === true && !receipt.resumeId;
    if (receipt.id !== id || (typeof receipt.requestId !== 'string' && !awaitingAck) ||
        typeof receipt.cwd !== 'string' || !receipt.submission || !receipt.profile) {
      throw failure('RECEIPT_UNKNOWN', `Execution ${id} has an incomplete receipt; do not resubmit it.`);
    }
    if (cwd && receipt.cwd !== await realpath(cwd)) {
      throw failure('CWD_MISMATCH', 'This execution belongs to a different working directory.');
    }
    return receipt;
  }

  async function allReceipts({ inspectMalformed = false } = {}) {
    let names;
    try { names = await readdir(receiptsDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      const id = name.slice(0, -5);
      try { return await read(id); }
      catch (error) {
        if (!inspectMalformed) throw error;
        return { id, ok: false, scope: 'unknown', cwd: null, provider: null, observation: 'unknown',
          detail: { ...errorData(error), message: 'Malformed receipt; its working directory and session scope are unknown. Inspect it before any mutation.' } };
      }
    }));
  }

  function runtimeFor(receipt) {
    return acpx.createSharedAcpRuntime({
      cwd: receipt.cwd,
      agentRegistry: acpx.createAgentRegistry({ overrides: { [receipt.profile.agent]: receipt.profile.argv } }),
      permissionMode: receipt.profile.permissionMode,
      nonInteractivePermissions: receipt.profile.nonInteractivePermissions ?? 'deny',
      authPolicy: 'skip',
      ttlMs,
    });
  }

  async function withSessionLock(receipt, run) {
    await mkdir(locksDir, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(JSON.stringify([
      receipt.cwd, receipt.provider, receipt.sessionKey,
    ])).digest('hex');
    const path = join(locksDir, `${key}.lock`);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw failure('SESSION_BUSY', 'Another integration operation holds this session. Inspect its execution before retrying; an abandoned lock requires explicit recovery.');
      throw error;
    }
    try {
      await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, executionId: receipt.id, createdAt: new Date().toISOString() }), { mode: 0o600 });
      return await run();
    } finally {
      await unlink(join(path, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(path);
    }
  }

  async function latestFor(receipt) {
    return (await allReceipts())
      .filter(item => item.cwd === receipt.cwd && item.provider === receipt.provider && item.sessionKey === receipt.sessionKey)
      .sort((a, b) => b.sequence - a.sequence)[0];
  }

  async function bindFreshIdentity(receipt, lockHeld) {
    const bind = async () => {
      const current = await read(receipt.id, receipt.cwd);
      if (current.nativeIdentity !== 'provisional') return current;
      if ((await latestFor(current))?.id !== current.id) throw failure('SUPERSEDED_EXECUTION', 'The first request is no longer the latest execution.');
      const runtime = runtimeFor(current);
      try {
        const handle = await runtime.findSession({ sessionKey: current.sessionKey, agent: current.profile.agent, cwd: current.cwd });
        if (!sameLocalHandle(handle, current.handle)) throw failure('RESUME_MISS', 'The original local session record is unavailable or changed.');
        const status = await runtime.getStatus({ handle });
        if (status.acpxRecordId !== handle.acpxRecordId || status.backendSessionId !== handle.backendSessionId || status.lastRequestId !== current.requestId) {
          throw failure('RESUME_MISS', 'The settled request no longer matches the public session identity.');
        }
        verifyChoices(current, status);
        const bound = { ...current, handle, reportedModel: status.models?.currentModelId ?? null,
          nativeIdentity: 'bound', identityBoundAt: new Date().toISOString() };
        await save(bound);
        return bound;
      } finally { await runtime.shutdown(); }
    };
    try { return lockHeld ? await bind() : await withSessionLock(receipt, bind); }
    catch (error) { return { ...receipt, bindingError: errorData(error) }; }
  }

  async function observeReceipt(receipt, timeoutMs, { enforceDeadline = true, lockHeld = false } = {}) {
    const baseResult = { ...receipt, ok: true, report: '', result: null };
    if (receipt.submission.stage === 'failed') {
      return { ...baseResult, ok: false, observation: 'terminal', result: receipt.submission.result ?? { status: 'failed', error: receipt.submission.error } };
    }
    if (!receipt.handle || !receipt.requestId) {
      return { ...baseResult, ok: false, observation: 'unknown', detail: 'A confirmed session handle and matching request acknowledgement are required; do not resubmit this execution.' };
    }
    const runtime = runtimeFor(receipt);
    const stop = new AbortController();
    const remaining = enforceDeadline ? receipt.observationDeadline - Date.now() : Infinity;
    const duration = remaining <= 0 ? Math.min(timeoutMs, INSPECTION_MS) : Math.min(timeoutMs, remaining);
    const timer = setTimeout(() => stop.abort(), Math.max(1, duration));
    let seen = false;
    let report = '';
    let result;
    let watchError;
    try {
      for await (const event of runtime.watchSession({ handle: receipt.handle, signal: stop.signal })) {
        if (event.requestId !== receipt.requestId) continue;
        seen = true;
        if (event.type === 'message') report += reportText(event.message);
        if (event.type === 'turn_result') { result = event.result; break; }
      }
    } catch (error) {
      if (!stop.signal.aborted) watchError = errorData(error);
    } finally {
      clearTimeout(timer);
      await runtime.shutdown();
    }
    if (result) {
      const current = receipt.nativeIdentity === 'provisional' ? await bindFreshIdentity(receipt, lockHeld) : receipt;
      return { ...current, report, result, observation: 'terminal', ok: result.status === 'completed',
        continuationAvailable: current.nativeIdentity !== 'provisional' };
    }
    if (watchError || !seen) {
      return { ...baseResult, ok: false, report, observation: 'unknown', detail: watchError ?? 'No retained journal event confirms this request. It may be pending, lost, or outside retention; do not resubmit.' };
    }
    const expired = enforceDeadline && Date.now() >= receipt.observationDeadline;
    return { ...baseResult, report, observation: expired ? 'expired' : 'pending', detail: 'Observation stopped; the upstream execution may still be running.' };
  }

  async function observe({ id, cwd, timeoutMs = 60_000, enforceDeadline = true }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw failure('INVALID_OBSERVATION_TIMEOUT', 'Observation timeout must be an integer from 1 through 60000 milliseconds.');
    }
    return observeReceipt(await read(id, cwd), timeoutMs, { enforceDeadline });
  }

  async function assertSettledLatest(receipt) {
    const latest = await latestFor(receipt);
    if (latest?.id !== receipt.id) throw failure('SUPERSEDED_EXECUTION', `Continue the latest execution ${latest?.id ?? '(unknown)'}, not this older turn.`);
    const observed = await observeReceipt(receipt, INSPECTION_MS, { enforceDeadline: false, lockHeld: true });
    if (observed.observation !== 'terminal' || !['accepted', 'queued'].includes(observed.submission.stage) || observed.nativeIdentity === 'provisional') {
      throw failure('SESSION_UNSETTLED', 'The selected request has no confirmed settled upstream result; continuation was not submitted.');
    }
    return observed;
  }

  async function start(input) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw failure('PROMPT_REQUIRED', 'Provide a non-empty prompt.');
    const cwd = await realpath(input.cwd);
    if (typeof input.provider !== 'string' || !input.provider) throw failure('PROVIDER_REQUIRED', 'Select a provider.');
    let previous = input.resumeId ? await read(input.resumeId, cwd) : null;
    if (previous && previous.provider !== input.provider) throw failure('PROVIDER_MISMATCH', 'A continuation must use the original provider.');
    const requestedModel = input.model ?? previous?.requestedModel ?? null;
    const access = input.access ?? previous?.access ?? 'write';
    const effort = input.effort ?? previous?.effort ?? null;
    if (previous && (requestedModel !== previous.requestedModel || access !== previous.access || effort !== previous.effort)) {
      throw failure('SESSION_CHOICE_MISMATCH', 'Start a fresh execution to change the model, access mode, or effort.');
    }
    const profile = previous?.profile ?? profileCopy(await getProfile({ provider: input.provider, cwd, access, model: requestedModel, effort }));
    const freshViaCli = !previous && profile.freshViaCli === true;
    const id = `exec-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const receipt = {
      schema: 'rescue.execution.v1', id, requestId: freshViaCli ? null : randomUUID(),
      nativeIdentity: freshViaCli ? 'provisional' : 'bound',
      sessionKey: previous?.sessionKey ?? `rescue-${id}`,
      handle: null, provider: input.provider, cwd, requestedModel,
      reportedModel: previous?.reportedModel ?? null, access, effort, profile,
      resumeId: previous?.id ?? null, sequence: (previous?.sequence ?? 0) + 1,
      createdAt, observationDeadline: Date.now() + OBSERVATION_BUDGET_MS,
      submission: { stage: 'intent' },
    };
    const launch = async () => {
      if (previous) previous = await assertSettledLatest(previous);
      await save(receipt);
      const runtime = runtimeFor(receipt);
      let turn;
      let cliSubmissionAttempted = false;
      let transportAccepted = false;
      let upstreamResult;
      const budgetEnds = Date.now() + SETUP_BUDGET_MS;
      const withinBudget = promise => bounded(promise, budgetEnds - Date.now(), 'SUBMISSION_TIMEOUT');
      try {
        if (freshViaCli && !submitFresh) throw failure('FRESH_SUBMISSION_UNAVAILABLE', 'The provider requires a configured first-submission adapter.');
        if (previous) {
          receipt.handle = await withinBudget(runtime.findSession({ sessionKey: receipt.sessionKey, agent: profile.agent, cwd }));
          if (!sameHandle(receipt.handle, previous.handle)) throw failure('RESUME_MISS', 'The recorded local/native session identity is unavailable or changed; no prompt was submitted.');
        } else {
          receipt.handle = await withinBudget(runtime.ensureSession({
            sessionKey: receipt.sessionKey, agent: profile.agent, mode: 'persistent', cwd,
            sessionOptions: profile.sessionOptions,
          }));
        }
        const status = await withinBudget(runtime.getStatus({ handle: receipt.handle }));
        if (!previous && configureSession) await withinBudget(configureSession({ runtime, handle: receipt.handle, profile, status }));
        if (freshViaCli) {
          const refreshed = await withinBudget(runtime.findSession({ sessionKey: receipt.sessionKey, agent: profile.agent, cwd }));
          if (!sameLocalHandle(refreshed, receipt.handle)) throw failure('RESUME_MISS', 'The fresh local session record changed during configuration; no prompt was submitted.');
          receipt.handle = refreshed;
        }
        const confirmed = await withinBudget(runtime.getStatus({ handle: receipt.handle }));
        if (confirmed.acpxRecordId !== receipt.handle.acpxRecordId || confirmed.backendSessionId !== receipt.handle.backendSessionId) {
          throw failure('RESUME_MISS', 'Session identity changed during configuration; no prompt was submitted.');
        }
        if (previous && confirmed.lastRequestId !== previous.requestId) {
          throw failure('RESUME_MISS', 'The upstream latest request no longer matches the selected execution; no prompt was submitted.');
        }
        verifyChoices(receipt, confirmed);
        if (freshViaCli && confirmed.lastRequestId) throw failure('FRESH_SCOPE_USED', 'The fresh session already has an upstream request; no prompt was submitted.');
        receipt.reportedModel = confirmed.models?.currentModelId ?? null;
        receipt.submission = { stage: 'prepared' };
        await save(receipt);
        if (freshViaCli) {
          cliSubmissionAttempted = true;
          const ack = await withinBudget(submitFresh({ runtime, handle: receipt.handle, profile, cwd, prompt: input.prompt }));
          if (ack?.action !== 'prompt_queued' || typeof ack.requestId !== 'string' || !ack.requestId || ack.acpxRecordId !== receipt.handle.acpxRecordId) {
            throw failure('ACK_MISSING', 'The first submission did not return a matching queue acknowledgement; do not resubmit.');
          }
          receipt.requestId = ack.requestId;
          receipt.submission = { stage: 'queued', queuedAt: new Date().toISOString() };
          receipt.observationDeadline = Date.now() + OBSERVATION_BUDGET_MS;
          await save(receipt);
          return { ...receipt, ok: true };
        }
        turn = runtime.startTurn({ handle: receipt.handle, requestId: receipt.requestId, mode: 'prompt', text: input.prompt });
        void turn.promptStarted.then(() => { transportAccepted = true; }, () => {});
        void turn.result.then(result => { upstreamResult = result; }, () => {});
        await withinBudget(turn.promptStarted);
        receipt.submission = { stage: 'accepted', acceptedAt: new Date().toISOString() };
        receipt.observationDeadline = Date.now() + OBSERVATION_BUDGET_MS;
        await save(receipt);
        return { ...receipt, ok: true };
      } catch (error) {
        const knownUnsubmittedFailure = !cliSubmissionAttempted && (!turn || (!transportAccepted && upstreamResult?.status === 'failed' && !uncertain(upstreamResult.error)));
        receipt.submission = knownUnsubmittedFailure
          ? { stage: 'failed', error: errorData(error), ...(upstreamResult ? { result: upstreamResult } : {}) }
          : { stage: 'unknown', error: errorData(error) };
        await save(receipt).catch(() => {});
        return { ...receipt, ok: false };
      } finally {
        await turn?.closeStream();
        await runtime.shutdown();
      }
    };
    return withSessionLock(previous ?? receipt, launch);
  }

  async function list({ cwd, provider } = {}) {
    const target = await realpath(cwd);
    const inspected = await allReceipts({ inspectMalformed: true });
    const receipts = inspected.filter(item => item.cwd === target && (!provider || item.provider === provider));
    receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence);
    return [...await Promise.all(receipts.map(item => observeReceipt(item, INSPECTION_MS))),
      ...inspected.filter(item => item.scope === 'unknown')];
  }

  async function resumeCandidate({ cwd, provider, id } = {}) {
    const target = await realpath(cwd);
    const receipts = id ? [await read(id, target)] : (await allReceipts())
      .filter(item => item.cwd === target && item.provider === provider)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence);
    for (const receipt of receipts) {
      if (receipt.provider !== provider || !['accepted', 'queued'].includes(receipt.submission.stage)) continue;
      const latest = await latestFor(receipt);
      if (latest?.id !== receipt.id) continue;
      const observed = await observeReceipt(receipt, INSPECTION_MS, { enforceDeadline: false });
      if (observed.observation === 'terminal' && observed.nativeIdentity !== 'provisional') return { available: true, receipt: await read(receipt.id, target), result: observed.result };
      if (id) return { available: false, reason: observed.bindingError ?? observed.observation, receipt: await read(receipt.id, target) };
    }
    return { available: false };
  }

  async function cancel({ id, cwd }) {
    const receipt = await read(id, cwd);
    return withSessionLock(receipt, async () => {
      const observed = await observeReceipt(receipt, INSPECTION_MS, { enforceDeadline: false, lockHeld: true });
      if (observed.observation === 'terminal') return { ...observed, cancellation: 'not-needed' };
      const latest = await latestFor(receipt);
      if (latest?.id !== receipt.id) throw failure('SUPERSEDED_EXECUTION', 'An older execution cannot cancel a later continuation.');
      if (observed.observation === 'unknown' || !['accepted', 'queued'].includes(receipt.submission.stage)) {
        throw failure('CANCELLATION_UNCERTAIN', 'The target request is not confirmed active; cancellation was not sent.');
      }
      const runtime = runtimeFor(receipt);
      try {
        const handle = await runtime.findSession({ sessionKey: receipt.sessionKey, agent: receipt.profile.agent, cwd: receipt.cwd });
        const identityMatches = receipt.nativeIdentity === 'provisional' && !receipt.resumeId
          ? sameLocalHandle(handle, receipt.handle) : sameHandle(handle, receipt.handle);
        if (!identityMatches) throw failure('RESUME_MISS', 'The original session identity changed; cancellation was not sent.');
        const status = await runtime.getStatus({ handle });
        if (status.lastRequestId !== receipt.requestId) throw failure('CANCELLATION_UNCERTAIN', 'The upstream current request identity differs; cancellation was not sent.');
        await runtime.cancel({ handle, reason: 'Explicit user cancellation' });
      } finally { await runtime.shutdown(); }
      const settled = await observeReceipt(receipt, INSPECTION_MS, { enforceDeadline: false, lockHeld: true });
      return { ...settled, cancellation: settled.result?.status === 'cancelled' ? 'confirmed' : 'requested' };
    });
  }

  return { start, observe, list, cancel, resumeCandidate };
}
