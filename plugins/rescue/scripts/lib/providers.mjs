import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
export const PROVIDERS = ['grok', 'agy', 'devin'];
export const READ_ONLY_GUARD = 'This is a read-only task. Do not modify files, execute shell commands, or use network tools. Use available file-reading tools and finish with your findings. Report denied tools and unverified claims explicitly.\n\n';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function getProfile({ provider, cwd, access = 'write', model, effort, discovery = false }) {
  model ??= undefined;
  effort ??= undefined;
  if (!PROVIDERS.includes(provider)) fail('PROVIDER_UNSUPPORTED', `Choose a provider: ${PROVIDERS.join(', ')}.`);
  if (!['write', 'read-only'].includes(access)) fail('ACCESS_UNSUPPORTED', 'Access must be write or read-only.');
  if (provider === 'agy' && !model && !discovery) fail('MODEL_REQUIRED', 'Choose an exact agy ACP model ID using models first.');
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) fail('MODEL_REQUIRED', 'Model ID must be a non-empty exact string.');
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('EFFORT_UNSUPPORTED', 'Unsupported reasoning effort.');
  const readOnly = access === 'read-only';
  let agent, argv, configOptions = [];
  if (provider === 'grok') {
    agent = 'grok-build';
    argv = ['grok', '--permission-mode', readOnly ? 'plan' : 'acceptEdits', '--sandbox', 'workspace', 'agent', 'stdio'];
  } else if (provider === 'agy') {
    agent = 'agy';
    argv = ['agy', 'acp', '--add-dir', cwd];
    configOptions.push({ key: 'mode', value: readOnly ? 'plan' : 'accept-edits' });
  } else {
    agent = 'devin';
    argv = ['devin', 'acp'];
    configOptions.push({ key: 'mode', value: readOnly ? 'ask' : 'accept-edits' });
  }
  if (effort) configOptions.push({ category: 'thought_level', value: effort });
  return {
    agent, argv, configOptions,
    ...(provider === 'devin' ? { freshViaCli: true } : {}),
    permissionMode: readOnly ? 'approve-reads' : 'approve-all',
    sessionOptions: {
      ...(model ? { model } : {}),
      ...(provider === 'devin' ? { env: { DEVIN_REFUSAL_FALLBACK: '' } } : {}),
    },
  };
}

function optionValues(options = []) {
  return options.flatMap(option => typeof option.value === 'string' ? [option.value] : optionValues(option.options));
}

export function resolveControls(profile, status) {
  const catalog = status.details?.configOptions ?? [];
  return (profile.configOptions ?? []).map(request => {
    const entry = catalog.find(option => request.key ? option.id === request.key : option.category === request.category);
    if (!entry || !optionValues(entry.options).includes(request.value)) {
      fail('CONFIG_UNSUPPORTED', `Provider does not advertise ${request.key ?? request.category}=${request.value}; no prompt was sent.`);
    }
    return { key: entry.id, value: request.value, currentValue: entry.currentValue };
  });
}

function quoteCommand(argv) {
  // Match the pinned runtime's argv identity. This is ACPX command-parser input,
  // passed as one execFile argument, never executable shell text.
  const safe = /^[A-Za-z0-9_@%+=:,./^~-]+$/u;
  return argv.map(value => safe.test(value) ? value : JSON.stringify(value)).join(' ');
}

export function sessionConfigurator(cliPath) {
  return async ({ runtime, handle, profile, status }) => {
    const controls = resolveControls(profile, status);
    for (const control of controls) {
      if (control.currentValue === control.value && !profile.freshViaCli) continue;
      // Shared controls require a running owner. A new session has none yet;
      // apply public CLI controls before any prompt, then check native identity.
      await run(process.execPath, [
        cliPath, '--cwd', handle.cwd, '--agent', quoteCommand(profile.argv),
        '--format', 'json', '--approve-reads', '--non-interactive-permissions', 'deny',
        '--timeout', '30', 'set', control.key, control.value, '-s', handle.sessionKey,
      ], { cwd: handle.cwd, env: { ...process.env, ...profile.sessionOptions?.env }, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      const updated = await runtime.getStatus({ handle });
      if (updated.acpxRecordId !== handle.acpxRecordId || (!profile.freshViaCli && updated.backendSessionId !== handle.backendSessionId)) {
        fail('SESSION_CHANGED', 'Provider session changed while configuring; no prompt was sent. Start a new execution.');
      }
      if (profile.freshViaCli) {
        const refreshed = await runtime.findSession({ sessionKey: handle.sessionKey, agent: profile.agent, cwd: handle.cwd });
        if (!refreshed || refreshed.acpxRecordId !== handle.acpxRecordId || refreshed.cwd !== handle.cwd) {
          fail('SESSION_CHANGED', 'Fresh session record changed during configuration; no prompt was sent.');
        }
        Object.assign(handle, refreshed);
      }
      const accepted = updated.details?.configOptions?.find(option => option.id === control.key);
      if (accepted?.currentValue !== control.value) fail('CONFIG_REJECTED', `Provider did not retain ${control.key}=${control.value}; no prompt was sent.`);
    }
  };
}

export function freshSubmitter(cliPath) {
  return async ({ handle, profile, cwd, prompt }) => {
    const directory = await mkdtemp(join(tmpdir(), 'rescue-prompt-'));
    const file = join(directory, 'prompt.txt');
    try {
      await writeFile(file, prompt, { flag: 'wx', mode: 0o600 });
      const { stdout } = await run(process.execPath, [
        cliPath, '--cwd', cwd, '--agent', quoteCommand(profile.argv),
        '--format', 'json', '--auth-policy', 'skip',
        profile.permissionMode === 'approve-all' ? '--approve-all' : '--approve-reads',
        '--non-interactive-permissions', 'deny', '--prompt-retries', '0',
        // Creation already selected the model. Re-selecting via the CLI can
        // replace an empty Devin session and discard its configured mode.
        'prompt', '--no-wait', '-s', handle.sessionKey, '--file', file,
      ], { cwd, env: { ...process.env, ...profile.sessionOptions?.env }, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      // This is acpx's public acknowledgement, not vendor output or a transcript.
      try { return JSON.parse(stdout); }
      catch { fail('ACK_MISSING', 'No valid acpx queue acknowledgement was received; inspect status and do not resubmit.'); }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function inspectProvider({ acpx, provider, cwd }) {
  const profile = getProfile({ provider, cwd, access: 'read-only', discovery: true });
  const runtime = acpx.createSharedAcpRuntime({
    cwd, permissionMode: 'approve-reads', nonInteractivePermissions: 'deny',
    authPolicy: 'skip', timeoutMs: 30000,
    agentRegistry: acpx.createAgentRegistry({ overrides: { [profile.agent]: profile.argv } }),
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: `rescue-inspect-${randomUUID()}`, agent: profile.agent, mode: 'persistent' });
    const status = await runtime.getStatus({ handle });
    return {
      ok: true, provider, inference: false,
      currentModel: status.models?.currentModelId ?? null,
      models: (status.models?.availableModels ?? []).map(item => ({ id: item.modelId, name: item.name })),
      configOptions: status.details?.configOptions ?? [],
    };
  } finally {
    if (handle) await runtime.close({ handle, reason: 'Provider inspection complete' }).catch(() => {});
    await runtime.shutdown();
  }
}
