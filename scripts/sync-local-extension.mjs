import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { artifactDirectory } from './artifact-directory.mjs';
import { resolvePnpmInvocation } from './package-manager-invocation.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const SEMVER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PUBLISHER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

if (isMainModule()) await main();

/**
 * Build and, only with --install, install a reviewed local VSIX candidate.
 * This command intentionally has no npm, GitHub, Open VSX, or Marketplace
 * write path. Public promotion is a separate, protected operation.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.publisher === undefined || !PUBLISHER.test(options.publisher)) {
    throw new Error('--publisher is required and must be a VS Code publisher id');
  }
  if (options.version === undefined || !SEMVER.test(options.version)) {
    throw new Error('--version is required and must be a semver version');
  }

  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const output = resolve(options.out ?? artifactDirectory('local-extension', `${options.publisher}-${options.version}-${stamp}.vsix`));
  const manifestPath = resolve(options.manifest ?? `${output}.sync.json`);
  await assertOutsideCheckout(output, 'local VSIX output');
  await assertOutsideCheckout(manifestPath, 'local sync manifest');
  await assertOutputReady(output, options.replace);
  await assertOutputReady(manifestPath, options.replace);

  const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const extensionName = sourcePackage.name;
  if (typeof extensionName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(extensionName)) {
    throw new Error(`package.json has an invalid extension name: ${String(extensionName)}`);
  }
  const extensionId = `${options.publisher}.${extensionName}`;
  const phases = [];
  let artifact = output;

  if (options.vsix !== undefined) {
    artifact = resolve(options.vsix);
    await assertOutsideCheckout(artifact, 'input VSIX');
    await assertRegularFile(artifact, 'input VSIX');
    phases.push({ name: 'candidate', status: 'provided' });
  } else {
    phases.push({ name: 'candidate', status: 'building' });
    await run('pnpm', ['package:vsix'], {
      env: {
        JSONLVIEW_VSIX_OUTPUT: output,
        JSONLVIEW_VSIX_MANIFEST: manifestPath,
        JSONLVIEW_VSIX_PUBLISHER: options.publisher,
        JSONLVIEW_VSIX_VERSION: options.version,
      },
    });
    phases[phases.length - 1].status = 'built';
  }

  const artifactDigest = await digestFile(artifact);
  const bundleDigests = await digestBundles();
  const report = {
    schemaVersion: 1,
    operation: 'local-extension-sync',
    createdAt: new Date().toISOString(),
    source: await gitState(),
    candidate: {
      path: '<external>/' + artifact.split(/[\\/]/).pop(),
      bytes: artifactDigest.bytes,
      sha256: artifactDigest.sha256,
      extensionId,
      name: extensionName,
      publisher: options.publisher,
      version: options.version,
      bundleSha256: bundleDigests,
    },
    vscode: {
      requested: options.install,
      code: options.code ?? 'auto',
      status: options.install ? 'pending' : 'not-requested',
      reloadRequired: false,
    },
    phases,
    publication: 'local-install only; npm/GitHub/Open VSX/Marketplace require separate release authorization',
  };

  if (options.install) {
    const runtime = await resolveCodeRuntime(options.code);
    report.vscode.code = runtime.codeCmd;
    const codeVersion = await readCodeVersion(runtime);
    const before = await scanInstalledExtensions(runtime);
    const conflicts = before.filter((entry) => entry.registered !== false
      && entry.name.toLowerCase().endsWith(`.${extensionName.toLowerCase()}`)
      && entry.name.toLowerCase() !== extensionId.toLowerCase());
    if (conflicts.length > 0) {
      report.vscode.status = 'blocked-conflict';
      report.vscode.conflicts = conflicts;
      await writeAtomic(manifestPath, report);
      throw new Error(`another publisher owns the same extension name; remove it explicitly before installing ${extensionId}: ${conflicts.map((entry) => entry.name).join(', ')}`);
    }
    phases.push({ name: 'install', status: 'installing' });
    await runCode(runtime, ['--install-extension', artifact, '--force']);
    const located = await locateInstalledExtension(runtime, extensionId, options.version);
    const installedPackage = JSON.parse(await readFile(join(located, 'package.json'), 'utf8'));
    if (installedPackage.name !== extensionName || installedPackage.publisher !== options.publisher || installedPackage.version !== options.version) {
      throw new Error(`installed extension identity mismatch at ${located}`);
    }
    const installedBundles = await digestBundlesAt(located);
    for (const [name, expected] of Object.entries(bundleDigests)) {
      if (expected !== undefined && installedBundles[name] !== expected) {
        throw new Error(`installed bundle digest mismatch for ${name}`);
      }
    }
    const after = await scanInstalledExtensions(runtime);
    if (!after.some((entry) => entry.registered !== false
      && entry.name.toLowerCase() === extensionId.toLowerCase()
      && entry.version === options.version)) {
      throw new Error(`VS Code did not report ${extensionId}@${options.version} after installation`);
    }
    report.vscode = {
      requested: true,
      code: runtime.codeCmd,
      codeVersion,
      status: 'installed',
      extensionPath: '<vscode-extension-root>/' + located.split(/[\\/]/).pop(),
      extensionId,
      version: options.version,
      bundleSha256: installedBundles,
      conflicts,
      reloadRequired: true,
      activeWindowReloaded: false,
    };
    phases[phases.length - 1].status = 'verified';
  }

  await writeAtomic(manifestPath, report);
  console.log(JSON.stringify({ ok: true, output: artifact, manifest: manifestPath, status: report.vscode.status, reloadRequired: report.vscode.reloadRequired }, null, 2));
}

export function parseArgs(args) {
  const input = [...args];
  if (input[0] === '--') input.shift();
  const parsed = {
    publisher: process.env.JSONLVIEW_VSCODE_PUBLISHER?.trim(),
    version: process.env.JSONLVIEW_VSCODE_VERSION?.trim(),
    code: process.env.JSONLVIEW_VSCODE_CODE_CMD?.trim(),
    vsix: undefined,
    out: undefined,
    manifest: undefined,
    install: false,
    replace: false,
  };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    if (key === '--install') {
      parsed.install = true;
      continue;
    }
    if (key === '--replace') {
      parsed.replace = true;
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--publisher') parsed.publisher = value;
    else if (key === '--version') parsed.version = value;
    else if (key === '--code') parsed.code = value;
    else if (key === '--vsix') parsed.vsix = value;
    else if (key === '--out') parsed.out = value;
    else if (key === '--manifest') parsed.manifest = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  return parsed;
}

async function resolveCodeRuntime(explicit) {
  const candidates = [
    explicit,
    process.env.JSONLVIEW_VSCODE_CODE_CMD,
    'D:\\Program Files\\vscode\\Microsoft VS Code\\bin\\code.cmd',
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  let codeCmd;
  for (const candidate of candidates) {
    try {
      const details = await lstat(resolve(candidate));
      if (details.isFile() && !details.isSymbolicLink()) {
        codeCmd = resolve(candidate);
        break;
      }
    } catch {
      // Try the next registered installation.
    }
  }
  if (codeCmd === undefined) throw new Error('portable VS Code code.cmd was not found; pass --code <path>');
  const binDirectory = dirname(codeCmd);
  const appRoot = resolve(binDirectory, '..');
  const electron = resolve(appRoot, 'Code.exe');
  await assertRegularFile(electron, 'VS Code executable');
  const script = await readFile(codeCmd, 'utf8');
  const match = script.match(/%~dp0\.\.\\([^\\\r\n]+)\\resources\\app\\out\\cli\.js/i);
  let cli;
  if (match?.[1]) cli = resolve(appRoot, match[1], 'resources', 'app', 'out', 'cli.js');
  if (cli === undefined || !(await isRegularFile(cli))) {
    // Portable installations may use a versioned folder not referenced by the
    // shim. Keep the search shallow and deterministic.
    for (const entry of await readdir(appRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(appRoot, entry.name, 'resources', 'app', 'out', 'cli.js');
      if (await isRegularFile(candidate)) {
        cli = candidate;
        break;
      }
    }
  }
  if (cli === undefined) throw new Error(`VS Code CLI script was not found beside ${codeCmd}`);
  return { codeCmd, electron, cli, appRoot };
}

async function runCode(runtime, args) {
  const result = await execFile(runtime.electron, [runtime.cli, ...args], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout ?? '';
}

async function locateInstalledExtension(runtime, extensionId, version) {
  const matches = (await scanInstalledExtensions(runtime))
    .filter((entry) => entry.name.toLowerCase() === extensionId.toLowerCase() && entry.version === version);
  if (matches.length === 0) throw new Error(`VS Code could not locate installed extension ${extensionId}`);
  const registered = matches.filter((entry) => entry.registered !== false);
  if (registered.length > 1) throw new Error(`multiple registered copies of ${extensionId}@${version} were found; remove stale copies before continuing`);
  return (registered[0] ?? matches[0]).path;
}

async function scanInstalledExtensions(runtime) {
  const roots = extensionRoots(runtime);
  const entries = [];
  const seen = new Set();
  for (const rootPath of roots) {
    const registeredPaths = await readRegisteredPaths(rootPath);
    let directories;
    try {
      directories = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const path = resolve(rootPath, directory.name);
      if (seen.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());
      try {
        const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
        if (typeof manifest.name !== 'string' || typeof manifest.publisher !== 'string' || typeof manifest.version !== 'string') continue;
        entries.push({
          name: `${manifest.publisher}.${manifest.name}`,
          version: manifest.version,
          path,
          registered: registeredPaths === undefined ? undefined : registeredPaths.has(path.toLowerCase()),
        });
      } catch {
        // An incomplete/stale directory is ignored unless it has a valid manifest.
      }
    }
  }
  return entries;
}

async function readRegisteredPaths(rootPath) {
  try {
    const value = JSON.parse(await readFile(join(rootPath, 'extensions.json'), 'utf8'));
    if (!Array.isArray(value)) return undefined;
    const paths = new Set();
    for (const entry of value) {
      const location = entry?.location;
      const candidate = typeof location?.fsPath === 'string'
        ? location.fsPath
        : typeof location?.path === 'string' && location.path.length > 0
          ? location.path
          : typeof entry?.relativeLocation === 'string'
            ? join(rootPath, entry.relativeLocation)
            : undefined;
      if (candidate) paths.add(resolve(candidate).toLowerCase());
    }
    return paths;
  } catch {
    return undefined;
  }
}

function extensionRoots(runtime) {
  const roots = [
    process.env.VSCODE_EXTENSIONS,
    resolve(runtime.appRoot, '..', '.vscode', 'extensions'),
    resolve(runtime.appRoot, 'extensions'),
    process.env.USERPROFILE === undefined ? undefined : resolve(process.env.USERPROFILE, '.vscode', 'extensions'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return [...new Set(roots.map((value) => resolve(value)))];
}

async function readCodeVersion(runtime) {
  try {
    const manifest = JSON.parse(await readFile(resolve(dirname(runtime.cli), '..', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function digestBundles() {
  const result = {};
  for (const name of ['dist/extension.cjs', 'dist/webview.js']) {
    const path = resolve(root, name);
    if (await isRegularFile(path)) result[name] = (await digestFile(path)).sha256;
  }
  return result;
}

async function digestBundlesAt(directory) {
  const result = {};
  for (const name of ['dist/extension.cjs', 'dist/webview.js']) {
    const path = join(directory, name);
    if (await isRegularFile(path)) result[name] = (await digestFile(path)).sha256;
  }
  return result;
}

async function digestFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`expected a regular file: ${path}`);
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function gitState() {
  const [sha, status, diff] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['status', '--porcelain=v1', '--untracked-files=all']),
    runGit(['diff', '--no-ext-diff', '--binary', 'HEAD']),
  ]);
  return sourceStateFromGitOutputs(sha, status, diff);
}

export function sourceStateFromGitOutputs(sha, status, diff) {
  const shaText = Buffer.isBuffer(sha) ? sha.toString('utf8') : String(sha);
  const statusBuffer = Buffer.isBuffer(status) ? status : Buffer.from(String(status));
  const diffBuffer = Buffer.isBuffer(diff) ? diff : Buffer.from(String(diff));
  return {
    sha: shaText.trim(),
    clean: statusBuffer.toString('utf8').trim().length === 0,
    statusSha256: createHash('sha256').update(statusBuffer).digest('hex'),
    diffSha256: createHash('sha256').update(diffBuffer).digest('hex'),
  };
}

async function runGit(args) {
  const result = await execFile('git', args, { cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertOutsideCheckout(path, label) {
  const resolved = resolve(path);
  const relativePath = relative(root, resolved);
  if (relativePath === '' || (!isAbsolute(relativePath) && !relativePath.startsWith('..'))) {
    throw new Error(`${label} must be outside the product checkout: ${path}`);
  }
}

async function assertOutputReady(path, replace) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`output must be a regular file: ${path}`);
    if (!replace) throw new Error(`output already exists; pass --replace for an intentional overwrite: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertRegularFile(path, label) {
  if (!(await isRegularFile(path))) throw new Error(`${label} is missing or not a regular file: ${path}`);
}

async function isRegularFile(path) {
  try {
    const details = await lstat(path);
    return details.isFile() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  const invocation = command === 'pnpm' ? resolvePnpmInvocation() : { command, prefix: [] };
  const result = await execFile(invocation.command, [...invocation.prefix, ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
