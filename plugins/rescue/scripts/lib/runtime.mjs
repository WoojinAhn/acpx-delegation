import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '0.22.0';
const shippedDirectory = fileURLToPath(new URL('../../runtime/', import.meta.url));

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function shippedPackage() {
  try {
    const manifest = readFileSync(path.join(shippedDirectory, 'package.json'));
    const lock = readFileSync(path.join(shippedDirectory, 'package-lock.json'));
    const pkg = JSON.parse(manifest);
    const locked = JSON.parse(lock);
    if (pkg.dependencies?.acpx !== VERSION ||
        locked.packages?.['']?.dependencies?.acpx !== VERSION ||
        locked.packages?.['node_modules/acpx']?.version !== VERSION) {
      throw new Error(`The shipped manifest and lockfile must both pin acpx ${VERSION}.`);
    }
    return { manifest, lock, hash: createHash('sha256').update(lock).digest('hex') };
  } catch (cause) {
    throw failure('RUNTIME_PACKAGE_INVALID', `The packaged acpx runtime is invalid: ${cause.message}`, cause);
  }
}

export function dataDirectory() {
  return path.resolve(process.env.RESCUE_DATA_DIR || path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'),
    'acpx-delegation',
  ));
}

function overrideDirectory() {
  const override = process.env.RESCUE_RUNTIME_DIR;
  if (!override) return undefined;
  if (!path.isAbsolute(override)) {
    throw failure('RUNTIME_PATH_INVALID', 'RESCUE_RUNTIME_DIR must be an absolute directory.');
  }
  return path.normalize(override);
}

function managedDirectory(shipped) {
  return path.join(dataDirectory(), 'runtime', `acpx-${VERSION}-${shipped.hash}`);
}

export function runtimeDirectory() {
  return overrideDirectory() || managedDirectory(shippedPackage());
}

async function inspectRuntime(root, shipped) {
  try {
    if (shipped) {
      const [manifest, lock] = await Promise.all([
        readFile(path.join(root, 'package.json')),
        readFile(path.join(root, 'package-lock.json')),
      ]);
      if (!manifest.equals(shipped.manifest) || !lock.equals(shipped.lock)) {
        throw failure('RUNTIME_LOCK_MISMATCH', 'Installed runtime manifests differ from the shipped locked package.');
      }
    }

    // Require a local package before resolving its public export; Node must not fall back to a parent installation.
    const packageRoot = await realpath(path.join(root, 'node_modules', 'acpx'));
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (pkg.version !== VERSION) {
      throw failure('RUNTIME_VERSION_MISMATCH', `Expected acpx ${VERSION}, found ${pkg.version ?? 'no version'}.`);
    }
    const require = createRequire(path.join(root, 'package.json'));
    const runtimePath = await realpath(require.resolve('acpx/runtime'));
    if (!runtimePath.startsWith(`${packageRoot}${path.sep}`)) {
      throw failure('RUNTIME_MODULE_INVALID', 'The acpx/runtime export resolves outside the selected acpx package.');
    }
    const cliPath = path.join(packageRoot, 'dist', 'cli.js');
    if (!(await stat(cliPath)).isFile()) {
      throw failure('RUNTIME_MODULE_INVALID', 'The installed acpx CLI is not a file.');
    }
    const acpx = await import(pathToFileURL(runtimePath).href);
    if (typeof acpx.createSharedAcpRuntime !== 'function') {
      throw failure('RUNTIME_MODULE_INVALID', 'The installed acpx runtime does not expose createSharedAcpRuntime.');
    }
    return { acpx, cliPath, version: VERSION, root };
  } catch (cause) {
    if (cause.code?.startsWith('RUNTIME_')) throw cause;
    throw failure('SETUP_REQUIRED', `acpx ${VERSION} is unavailable at ${root}. Run rescue setup first. ${cause.message}`, cause);
  }
}

export async function loadRuntime() {
  const override = overrideDirectory();
  if (override) return inspectRuntime(override);
  const shipped = shippedPackage();
  return inspectRuntime(managedDirectory(shipped), shipped);
}

function installDependencies(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'ci', '--ignore-scripts', '--omit=dev', '--no-fund',
    ], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-12000); });
    }
    child.on('error', (cause) => reject(failure('RUNTIME_INSTALL_FAILED', `Cannot run npm ci: ${cause.message}`, cause)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(failure('RUNTIME_INSTALL_FAILED', `npm ci failed (${signal || code}). ${diagnostics.trim()}`));
    });
  });
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function installRuntime() {
  const override = overrideDirectory();
  // The override is an explicitly prepared development installation, never an npm install target.
  if (override) return inspectRuntime(override);
  const shipped = shippedPackage();
  const root = managedDirectory(shipped);
  if (await exists(root)) return inspectRuntime(root, shipped);

  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${root}.install-lock`;
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (cause) {
    if (cause.code === 'EEXIST') {
      throw failure('SETUP_IN_PROGRESS', `Another setup holds ${lockPath}. Wait for it to finish. If it was interrupted, inspect that lock before retrying.`, cause);
    }
    throw cause;
  }

  let staging;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    await lock.close();
    if (await exists(root)) return await inspectRuntime(root, shipped);
    staging = await mkdtemp(path.join(parent, `.acpx-${VERSION}-staging-`));
    await Promise.all([
      writeFile(path.join(staging, 'package.json'), shipped.manifest, { mode: 0o600 }),
      writeFile(path.join(staging, 'package-lock.json'), shipped.lock, { mode: 0o600 }),
    ]);
    await installDependencies(staging);
    await inspectRuntime(staging, shipped);
    await rename(staging, root);
    staging = undefined;
    return await inspectRuntime(root, shipped);
  } finally {
    await lock.close().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
    // Do not remove a replacement lock owned by another setup.
    const held = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => undefined);
    if (held?.token === token) await rm(lockPath);
  }
}
