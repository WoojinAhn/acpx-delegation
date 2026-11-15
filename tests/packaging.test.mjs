import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(new URL('../', import.meta.url).pathname);
const bundle = join(root, 'plugins/rescue');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('both marketplaces resolve the same self-contained native plugin', async () => {
  const claude = await json(join(root, '.claude-plugin/marketplace.json'));
  const codex = await json(join(root, '.agents/plugins/marketplace.json'));
  assert.equal(claude.plugins[0].name, 'rescue');
  assert.equal(codex.plugins[0].name, 'rescue');
  assert.equal(resolve(root, claude.plugins[0].source), bundle);
  assert.equal(resolve(root, codex.plugins[0].source.path), bundle);
  const native = await json(join(bundle, '.codex-plugin/plugin.json'));
  const legacy = await json(join(bundle, '.claude-plugin/plugin.json'));
  assert.equal(native.name, legacy.name);
  assert.equal(native.version, legacy.version);
  const skills = join(bundle, native.skills);
  assert.deepEqual((await readdir(skills)).sort(), ['agy', 'cancel', 'devin', 'grok', 'models', 'result', 'setup', 'status']);
  for (const name of await readdir(skills)) {
    const path = join(skills, name, 'SKILL.md');
    const text = await readFile(path, 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      const reference = resolve(dirname(path), target);
      assert(reference.startsWith(bundle + '/'));
      assert((await stat(reference)).isFile());
    }
    assert((await stat(join(bundle, 'commands', `${name}.md`))).isFile());
  }
});

test('helper help runs from an isolated installed subtree without repo dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rescue-bundle-'));
  const installed = join(dir, 'cache/rescue/0.1.0');
  await cp(bundle, installed, { recursive: true });
  const { stdout } = await run(process.execPath, [join(installed, 'scripts/rescue.mjs'), '--help'], { cwd: dir });
  assert.match(stdout, /Providers: grok, agy, devin/);
  const { stdout: rejected } = await run(process.execPath, [join(installed, 'scripts/rescue.mjs'), 'start', 'grok', '--worktree'], { cwd: dir }).catch(error => error);
  const result = JSON.parse(rejected);
  assert.equal(result.ok, false);
  assert.match(result.code, /ERR_PARSE_ARGS/);
});
