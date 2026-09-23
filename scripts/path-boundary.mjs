import { lstat } from 'node:fs/promises';
import { dirname, parse, relative, resolve, sep } from 'node:path';

/** Return whether candidate resolves inside parent on the same filesystem volume. */
export function isWithin(parent, candidate) {
  if (parse(resolve(parent)).root.toLowerCase() !== parse(resolve(candidate)).root.toLowerCase()) return false;
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith('../'));
}

/**
 * Require a staging/deletion target to be lexically outside the product tree
 * and reject existing junction/symlink ancestors before a caller creates or
 * removes anything at that path.
 */
export async function assertOutsideTree(parent, candidate, label) {
  const resolved = resolve(candidate);
  if (isWithin(parent, resolved)) {
    throw new Error(`${label} must be outside the product checkout: ${resolved}`);
  }
  let cursor = resolved;
  while (true) {
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) {
        throw new Error(`${label} cannot pass through a symbolic-link or junction ancestor: ${cursor}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return resolved;
}

export function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

/** Prevent an artifact/manifest pair from overwriting or containing itself. */
export function assertPathsDoNotOverlap(left, right, message) {
  if (pathsOverlap(left, right)) throw new Error(message);
}
