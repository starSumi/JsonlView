import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export function resolveNpmInvocation() {
  const runtimeDirectory = dirname(process.execPath);
  const candidates = [
    resolve(runtimeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(runtimeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(isRegularFile);
  if (cli === undefined) {
    throw new Error(`npm CLI was not found in the active Node runtime: ${candidates.join(', ')}`);
  }
  return { command: process.execPath, prefix: [cli] };
}

export function resolvePnpmInvocation() {
  const activeCli = process.env.npm_execpath?.trim();
  const home = process.env.PNPM_HOME?.trim();
  const candidates = [
    activeCli !== undefined && /pnpm/i.test(basename(activeCli)) ? activeCli : undefined,
    home === undefined ? undefined : resolve(home, '..', 'pnpm', 'bin', 'pnpm.cjs'),
    resolve(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && isRegularFile(candidate)) {
      return { command: process.execPath, prefix: [candidate] };
    }
  }

  if (process.platform !== 'win32') return { command: 'pnpm', prefix: [] };
  const executable = findWindowsExecutable('pnpm');
  if (executable !== undefined) return { command: executable, prefix: [] };
  throw new Error('pnpm CLI could not be resolved without invoking a shell shim');
}

function findWindowsExecutable(name) {
  try {
    const output = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
    return output.split(/\r?\n/).map((entry) => entry.trim())
      .find((entry) => entry.toLowerCase().endsWith('.exe') && isRegularFile(entry));
  } catch {
    return undefined;
  }
}

function isRegularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
