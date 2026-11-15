#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { dataDirectory, installRuntime, loadRuntime } from './lib/runtime.mjs';
import { createExecutionService } from './lib/executions.mjs';
import { PROVIDERS, READ_ONLY_GUARD, getProfile, inspectProvider, sessionConfigurator, freshSubmitter } from './lib/providers.mjs';
import { preference } from './lib/preferences.mjs';

const HELP = `Rescue: on-demand delegation through acpx

  setup [PROVIDER] [--install]
  models PROVIDER [--filter TEXT] [--page N] [--limit 1..20]
  preference PROVIDER show|set MODEL|clear [--effort LEVEL]
  candidate PROVIDER [--resume ID]
  start PROVIDER --prompt-file PATH [--model ID] [--effort LEVEL]
        [--read-only|--write] [--fresh|--resume ID]
  wait ID [--timeout-ms 1..60000]
  status [PROVIDER]
  result [ID] [--provider PROVIDER]
  cancel [ID] [--provider PROVIDER]

All commands accept --cwd PATH. Providers: grok, agy, devin.
Each start is one execution. Host skills handle multi-model dispatch and delivery.
Observation expiry does not cancel. Unknown submission is never retried.
Setup --install installs the locked integration runtime, not vendor CLIs.
`;

function error(code, message) { throw Object.assign(new Error(message), { code }); }
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) error('USAGE', `Expected an integer between ${min} and ${max}.`);
  return Number(value);
}

async function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true, tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' }, cwd: { type: 'string' }, install: { type: 'boolean' },
      model: { type: 'string' }, effort: { type: 'string' }, 'read-only': { type: 'boolean' }, write: { type: 'boolean' },
      fresh: { type: 'boolean' }, resume: { type: 'string' }, 'prompt-file': { type: 'string' },
      'timeout-ms': { type: 'string' }, provider: { type: 'string' }, filter: { type: 'string' },
      page: { type: 'string' }, limit: { type: 'string' },
    },
  });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, argument, action, value, ...extra] = positionals;
  const permitted = {
    setup: ['install'], models: ['filter', 'page', 'limit'], preference: ['effort'], candidate: ['resume'],
    start: ['model', 'effort', 'read-only', 'write', 'fresh', 'resume', 'prompt-file'],
    wait: ['timeout-ms'], status: [], result: ['provider', 'timeout-ms'], cancel: ['provider'],
  }[command];
  if (!permitted) error('USAGE', `Unknown command: ${command}`);
  if (extra.length || (command !== 'preference' && (action || value))) error('USAGE', 'Unexpected positional arguments. Use --help.');
  const seen = new Set();
  for (const token of tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) error('USAGE', `Repeated --${token.name}; workers accept one value.`);
    seen.add(token.name);
    if (!['cwd', 'help', ...permitted].includes(token.name)) error('USAGE', `--${token.name} is not supported by ${command}.`);
  }
  const cwd = await realpath(values.cwd ?? process.cwd());
  const dataDir = dataDirectory();
  if (command === 'preference') {
    if (values.effort && action !== 'set') error('USAGE', '--effort is only valid with preference set.');
    if (value !== undefined && action !== 'set') error('USAGE', 'Only preference set accepts a model argument.');
    return preference(dataDir, argument, action, value, values.effort);
  }
  if (command === 'setup' && values.install) await installRuntime();
  const loaded = await loadRuntime();
  if (command === 'setup' && !argument) return { ok: true, acpxVersion: loaded.version, runtimeRoot: loaded.root, providers: PROVIDERS };
  if (command === 'setup' || command === 'models') {
    const inspected = await inspectProvider({ acpx: loaded.acpx, provider: argument, cwd });
    if (command === 'setup') return { ok: true, provider: argument, inference: false, acpxVersion: loaded.version, modelCount: inspected.models.length, currentModel: inspected.currentModel };
    const page = integer(values.page, 1, 1, 100000);
    const limit = integer(values.limit, 2, 1, 20);
    const query = values.filter?.toLowerCase() ?? '';
    const models = inspected.models.filter(item => `${item.id} ${item.name}`.toLowerCase().includes(query));
    return { ok: true, provider: argument, page, limit, total: models.length,
      models: models.slice((page - 1) * limit, page * limit),
      controls: inspected.configOptions.filter(option => option.category === 'thought_level'),
      preference: await preference(dataDir, argument) };
  }
  const service = createExecutionService({ dataDir, acpx: loaded.acpx, getProfile, configureSession: sessionConfigurator(loaded.cliPath), submitFresh: freshSubmitter(loaded.cliPath) });
  if (command === 'candidate') return service.resumeCandidate({ cwd, provider: argument, id: values.resume });
  if (command === 'start') {
    if (!values['prompt-file']) error('USAGE', 'start requires --prompt-file; task text never belongs in shell arguments.');
    if (values.fresh && values.resume) error('USAGE', 'Choose fresh or resume, not both.');
    if (values['read-only'] && values.write) error('USAGE', 'Choose one access mode.');
    const prompt = await readFile(values['prompt-file'], 'utf8');
    if (!prompt.trim()) error('USAGE', 'Prompt file is empty.');
    const saved = values.model === undefined && !values.resume ? await preference(dataDir, argument) : {};
    const model = values.model ?? saved.model ?? undefined;
    const effort = values.effort ?? saved.effort ?? undefined;
    const access = values['read-only'] ? 'read-only' : values.write ? 'write' : undefined;
    let effectiveAccess = access;
    if (values.resume && !access) effectiveAccess = (await service.resumeCandidate({ cwd, provider: argument, id: values.resume }))?.receipt?.access;
    return service.start({ provider: argument, cwd, model, effort, access,
      resumeId: values.resume, prompt: effectiveAccess === 'read-only' ? READ_ONLY_GUARD + prompt : prompt });
  }
  if (command === 'wait') {
    if (!argument) error('USAGE', 'wait requires an execution ID.');
    return service.observe({ id: argument, cwd, timeoutMs: integer(values['timeout-ms'], 60000, 1, 60000) });
  }
  if (command === 'status') {
    const rows = await service.list({ cwd, provider: argument });
    return { ok: true, executions: rows.map(({ report, ...row }) => row) };
  }
  let id = argument;
  if (!id) {
    const rows = await service.list({ cwd, provider: values.provider });
    if (command === 'result') id = rows.find(row => row.observation === 'terminal')?.id;
    else {
      const unsettled = rows.filter(row => row.observation !== 'terminal');
      if (unsettled.length !== 1) error('AMBIGUOUS_EXECUTION', `Specify one execution ID. Candidates: ${unsettled.map(row => row.id).join(', ') || 'none'}`);
      id = unsettled[0].id;
    }
  }
  if (!id) error('NOT_FOUND', 'No matching completed execution. Use status to inspect recent work.');
  if (command === 'result') return service.observe({ id, cwd, timeoutMs: integer(values['timeout-ms'], 1000, 1, 60000), enforceDeadline: false });
  return service.cancel({ id, cwd });
}

try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify(result));
  if (result?.ok === false) process.exitCode = 1;
} catch (failure) {
  console.log(JSON.stringify({ ok: false, code: failure.code ?? 'ERROR', message: failure.message }));
  process.exitCode = failure.code === 'USAGE' || failure.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
}
