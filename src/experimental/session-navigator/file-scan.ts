import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import type { SessionNavigatorBudget } from './types';

const MAX_DEPTH = 8;
const MAX_DIRECTORY_MULTIPLIER = 4;
const JSONL_EXTENSIONS = new Set(['.jsonl', '.ndjson']);

export interface FileEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly size: bigint;
  readonly mtimeMs: number;
}

export async function collectFiles(rootPath: string, signal: AbortSignal, budget: SessionNavigatorBudget, startedAt: number): Promise<FileEntry[]> {
  const root = resolve(rootPath);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error('Session navigator refuses a symbolic-link source root.');
  if (rootInfo.isFile()) {
    return JSONL_EXTENSIONS.has(extname(root).toLowerCase())
      ? [{ path: root, relativePath: basename(root), size: BigInt(rootInfo.size), mtimeMs: rootInfo.mtimeMs }]
      : [];
  }
  if (!rootInfo.isDirectory()) return [];
  const result: FileEntry[] = [];
  const maxDirectories = Math.max(16, budget.maxFiles * MAX_DIRECTORY_MULTIPLIER);
  let directoriesVisited = 0;
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0 && result.length < budget.maxFiles && directoriesVisited < maxDirectories) {
    throwIfAborted(signal);
    if (Date.now() - startedAt >= budget.maxMilliseconds) break;
    const current = queue.shift()!;
    directoriesVisited += 1;
    const entries = await readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= budget.maxFiles) break;
      throwIfAborted(signal);
      if (Date.now() - startedAt >= budget.maxMilliseconds) break;
      const candidate = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) queue.push({ path: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !JSONL_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const info = await stat(candidate);
      result.push({ path: candidate, relativePath: relative(root, candidate), size: BigInt(info.size), mtimeMs: info.mtimeMs });
    }
  }
  return result;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Session navigator scan cancelled.');
}
