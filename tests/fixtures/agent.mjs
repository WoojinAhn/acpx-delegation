import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = process.argv[2];
const unsavedEmpty = process.argv[3] === 'unsaved-empty';
await mkdir(directory, { recursive: true });
const running = new Map();
const sessions = new Map();
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const modelInfo = currentModelId => ({ currentModelId, availableModels: [
  { modelId: 'fixture-a', name: 'Fixture A' }, { modelId: 'fixture-b', name: 'Fixture B' },
] });
const configInfo = session => [
  { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: session.mode,
    options: [{ value: 'ask', name: 'Ask' }, { value: 'accept-edits', name: 'Accept edits' }] },
  { id: 'thought_level', name: 'Thought level', type: 'select', category: 'thought_level', currentValue: session.effort,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
const sessionPath = id => join(directory, `${id}.json`);
const load = async id => {
  if (sessions.has(id)) return sessions.get(id);
  try { return JSON.parse(await readFile(sessionPath(id), 'utf8')); }
  catch (error) {
    if (unsavedEmpty && error.code === 'ENOENT') throw Object.assign(new Error('Empty fixture session cannot be loaded'), { code: -32602 });
    throw error;
  }
};
const save = async session => {
  sessions.set(session.id, session);
  if (!unsavedEmpty || session.prompts.length) await writeFile(sessionPath(session.id), JSON.stringify(session));
};

async function request(message) {
  const { id, method, params = {} } = message;
  await appendFile(join(directory, 'calls.ndjson'), `${JSON.stringify({ method, pid: process.pid, sessionId: params.sessionId, text: params.prompt?.map(item => item.text ?? '').join('') })}\n`);
  if (method === 'initialize') {
    if (process.argv[3] === 'hang-initialize') await new Promise(() => {});
    return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'rescue-fixture', version: '1.0.0' } };
  }
  if (method === 'session/new') {
    const session = { id: randomUUID(), model: 'fixture-a', mode: 'accept-edits', effort: 'low', prompts: [] };
    await save(session);
    return { sessionId: session.id, models: modelInfo(session.model), configOptions: configInfo(session) };
  }
  if (method === 'session/load') {
    const session = await load(params.sessionId);
    return { models: modelInfo(session.model), configOptions: configInfo(session) };
  }
  if (method === 'session/set_model') {
    if (!['fixture-a', 'fixture-b'].includes(params.modelId)) throw new Error('Unknown fixture model');
    const session = await load(params.sessionId);
    session.model = params.modelId;
    await save(session);
    return {};
  }
  if (method === 'session/set_config_option') {
    const session = await load(params.sessionId);
    const field = params.configId === 'mode' ? 'mode' : params.configId === 'thought_level' ? 'effort' : null;
    const option = configInfo(session).find(item => item.id === params.configId);
    if (!field || !option.options.some(item => item.value === params.value)) throw new Error('Unknown fixture config choice');
    session[field] = params.value;
    await save(session);
    return { configOptions: configInfo(session) };
  }
  if (method === 'session/cancel') {
    const active = running.get(params.sessionId);
    if (active) { active.cancelled = true; active.wake(); }
    return {};
  }
  if (method === 'session/close') return {};
  if (method === 'session/prompt') {
    const session = await load(params.sessionId);
    const text = params.prompt.map(item => item.text ?? '').join('');
    session.prompts.push(text);
    await save(session);
    if (text === 'crash-after-submit') process.exit(23);
    let timer;
    const state = { cancelled: false, wake() {} };
    running.set(session.id, state);
    const delay = Number(/^delay:(\d+)\n/.exec(text)?.[1] ?? 0);
    if (delay) await new Promise(resolve => { state.wake = resolve; timer = setTimeout(resolve, delay); });
    clearTimeout(timer);
    const output = `turn=${session.prompts.length};model=${session.model};${state.cancelled ? 'cancelled' : text};mode=${session.mode};effort=${session.effort}`;
    send({ method: 'session/update', params: { sessionId: session.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } } } });
    running.delete(session.id);
    return { stopReason: state.cancelled ? 'cancelled' : 'end_turn' };
  }
  if (id !== undefined) throw new Error(`Unsupported fixture method ${method}`);
}

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  request(message).then(result => {
    if (message.id !== undefined) send({ id: message.id, result: result ?? {} });
  }, error => {
    if (message.id !== undefined) send({ id: message.id, error: { code: typeof error.code === 'number' ? error.code : -32603, message: error.message } });
  });
});
