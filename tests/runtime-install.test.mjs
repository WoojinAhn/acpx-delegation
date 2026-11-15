import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const plugin = fileURLToPath(new URL('../plugins/rescue/', import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rescue-runtime-test-')));
  t.after(async () => {
    await chmod(path.join(root, 'plugin-cache', 'runtime'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bundle = path.join(root, 'plugin-cache');
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  await Promise.all([
    mkdir(path.join(bundle, 'scripts', 'lib'), { recursive: true }),
    mkdir(path.join(bundle, 'runtime'), { recursive: true }),
    mkdir(bin),
  ]);
  await Promise.all([
    copyFile(path.join(plugin, 'scripts', 'lib', 'runtime.mjs'), path.join(bundle, 'scripts', 'lib', 'runtime.mjs')),
    copyFile(path.join(plugin, 'runtime', 'package.json'), path.join(bundle, 'runtime', 'package.json')),
    copyFile(path.join(plugin, 'runtime', 'package-lock.json'), path.join(bundle, 'runtime', 'package-lock.json')),
  ]);
  const npm = path.join(bin, 'npm');
  await writeFile(npm, `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
await fs.appendFile(process.env.RESCUE_TEST_CALLS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.env.RESCUE_TEST_FAIL) { console.error('fixture install failed'); process.exit(7); }
if (process.env.RESCUE_TEST_GATE) {
  await fs.writeFile(process.env.RESCUE_TEST_GATE + '.started', 'ready');
  while (true) {
    try { await fs.access(process.env.RESCUE_TEST_GATE); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
const root = path.join(process.cwd(), 'node_modules', 'acpx');
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'acpx', version: '0.22.0', type: 'module', exports: { './runtime': './dist/runtime.js' } }));
await fs.writeFile(path.join(root, 'dist', 'runtime.js'), 'export function createSharedAcpRuntime() { return { fixture: true }; }');
await fs.writeFile(path.join(root, 'dist', 'cli.js'), '// fixture CLI');
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RESCUE_DATA_DIR: data,
    RESCUE_TEST_CALLS: path.join(root, 'calls.ndjson'),
  };
  delete env.RESCUE_RUNTIME_DIR;
  delete env.RESCUE_TEST_FAIL;
  delete env.RESCUE_TEST_GATE;
  const moduleURL = pathToFileURL(path.join(bundle, 'scripts', 'lib', 'runtime.mjs')).href;
  const source = (operation) => `
    import * as runtime from ${JSON.stringify(moduleURL)};
    try {
      const value = await runtime[${JSON.stringify(operation)}]();
      console.log(JSON.stringify(typeof value === 'string' ? { value } : {
        root: value.root, cliPath: value.cliPath, version: value.version,
        hasSharedRuntime: typeof value.acpx.createSharedAcpRuntime === 'function'
      }));
    } catch (error) { console.log(JSON.stringify({ error: error.code, message: error.message })); }
  `;
  const run = async (operation, extraEnv = {}) => {
    const result = await execute(process.execPath, ['--input-type=module', '--eval', source(operation)], {
      env: { ...env, ...extraEnv }, timeout: 10000,
    });
    return JSON.parse(result.stdout);
  };
  return { root, bundle, data, env, source, run };
}

async function waitForFile(file) {
  for (let count = 0; count < 250; count++) {
    try { await readFile(file); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${file}`);
}

test('load requires explicit setup without creating data or running npm', async (t) => {
  const f = await fixture(t);
  const result = await f.run('loadRuntime');
  assert.equal(result.error, 'SETUP_REQUIRED');
  assert.match(result.message, /rescue setup/);
  await assert.rejects(readdir(f.data), { code: 'ENOENT' });
  await assert.rejects(readFile(f.env.RESCUE_TEST_CALLS), { code: 'ENOENT' });
});

test('setup installs a locked runtime outside an immutable plugin cache and is idempotent', async (t) => {
  const f = await fixture(t);
  const sourceLock = path.join(f.bundle, 'runtime', 'package-lock.json');
  const lockBytes = await readFile(sourceLock);
  await chmod(path.join(f.bundle, 'runtime', 'package.json'), 0o444);
  await chmod(sourceLock, 0o444);
  await chmod(path.dirname(sourceLock), 0o555);
  const installed = await f.run('installRuntime');
  assert.equal(installed.version, '0.22.0');
  assert.equal(installed.hasSharedRuntime, true);
  assert.equal(installed.root, path.join(f.data, 'runtime', `acpx-0.22.0-${createHash('sha256').update(lockBytes).digest('hex')}`));
  assert.equal(installed.cliPath, await realpath(path.join(installed.root, 'node_modules', 'acpx', 'dist', 'cli.js')));
  assert.deepEqual(await f.run('loadRuntime'), installed);
  assert.deepEqual(await f.run('installRuntime'), installed);
  const calls = (await readFile(f.env.RESCUE_TEST_CALLS, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['ci', '--ignore-scripts', '--omit=dev', '--no-fund']);
  assert.equal(path.dirname(calls[0].cwd), path.dirname(installed.root));
  assert.deepEqual(await readFile(sourceLock), lockBytes);
  assert.deepEqual(await readFile(path.join(installed.root, 'package-lock.json')), lockBytes);
  assert.deepEqual(await readdir(path.dirname(installed.root)), [path.basename(installed.root)]);
});

test('concurrent setup refuses duplicate installation until the owning setup finishes', async (t) => {
  const f = await fixture(t);
  const gate = path.join(f.root, 'release-installer');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', f.source('installRuntime')], {
    env: { ...f.env, RESCUE_TEST_GATE: gate }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Installer exited ${code}`)));
  });
  await waitForFile(`${gate}.started`);
  try {
    const second = await f.run('installRuntime');
    assert.equal(second.error, 'SETUP_IN_PROGRESS');
  } finally {
    await writeFile(gate, 'continue');
    await complete;
  }
  assert.equal(JSON.parse(output).version, '0.22.0');
  const calls = (await readFile(f.env.RESCUE_TEST_CALLS, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
});

test('failed setup removes only its staging and lock, leaving unrelated data untouched', async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.data, 'runtime');
  await mkdir(parent, { recursive: true });
  await writeFile(path.join(parent, 'unrelated.txt'), 'keep');
  const result = await f.run('installRuntime', { RESCUE_TEST_FAIL: '1' });
  assert.equal(result.error, 'RUNTIME_INSTALL_FAILED');
  assert.match(result.message, /fixture install failed/);
  assert.deepEqual(await readdir(parent), ['unrelated.txt']);
  assert.equal(await readFile(path.join(parent, 'unrelated.txt'), 'utf8'), 'keep');
});

test('a mismatched shipped acpx lock is rejected before npm or data writes', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.bundle, 'runtime', 'package-lock.json');
  const locked = JSON.parse(await readFile(file, 'utf8'));
  locked.packages['node_modules/acpx'].version = '0.21.1';
  await writeFile(file, JSON.stringify(locked));
  const result = await f.run('installRuntime');
  assert.equal(result.error, 'RUNTIME_PACKAGE_INVALID');
  await assert.rejects(readdir(f.data), { code: 'ENOENT' });
  await assert.rejects(readFile(f.env.RESCUE_TEST_CALLS), { code: 'ENOENT' });
});

test('tampered installed lock is rejected rather than repaired or ignored', async (t) => {
  const f = await fixture(t);
  const installed = await f.run('installRuntime');
  await writeFile(path.join(installed.root, 'package-lock.json'), '{}');
  assert.equal((await f.run('loadRuntime')).error, 'RUNTIME_LOCK_MISMATCH');
  assert.equal((await f.run('installRuntime')).error, 'RUNTIME_LOCK_MISMATCH');
  assert.equal((await readFile(f.env.RESCUE_TEST_CALLS, 'utf8')).trim().split('\n').length, 1);
});

test('development override requires an absolute, local, exact-version public runtime', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('loadRuntime', { RESCUE_RUNTIME_DIR: 'relative' })).error, 'RUNTIME_PATH_INVALID');
  const installed = await f.run('installRuntime');
  assert.deepEqual(await f.run('loadRuntime', { RESCUE_RUNTIME_DIR: installed.root }), installed);
  const nested = path.join(installed.root, 'nested');
  await mkdir(nested);
  assert.equal((await f.run('loadRuntime', { RESCUE_RUNTIME_DIR: nested })).error, 'SETUP_REQUIRED');
  const packageFile = path.join(installed.root, 'node_modules', 'acpx', 'package.json');
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  pkg.version = '0.22.1';
  await writeFile(packageFile, JSON.stringify(pkg));
  assert.equal((await f.run('loadRuntime', { RESCUE_RUNTIME_DIR: installed.root })).error, 'RUNTIME_VERSION_MISMATCH');
  pkg.version = '0.22.0';
  await writeFile(packageFile, JSON.stringify(pkg));
  await writeFile(path.join(installed.root, 'node_modules', 'acpx', 'dist', 'runtime.js'), 'export const unrelated = true;');
  assert.equal((await f.run('loadRuntime', { RESCUE_RUNTIME_DIR: installed.root })).error, 'RUNTIME_MODULE_INVALID');
});
