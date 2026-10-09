import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionNavigatorProvider as createFromCompatibilityBarrel,
  FileSessionNavigatorProvider,
} from '../../src/experimental/session-navigator/file-provider';
import { createSessionNavigatorProvider } from '../../src/experimental/session-navigator/provider-factory';

describe('session navigator provider factory boundary', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('keeps the compatibility barrel while dispatching generic and native providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-provider-factory-'));
    cleanup.push(root);
    const rootUri = pathToFileURL(root).toString();

    expect(createFromCompatibilityBarrel).toBe(createSessionNavigatorProvider);
    expect(createSessionNavigatorProvider({ provider: 'generic', rootUri })).toBeInstanceOf(FileSessionNavigatorProvider);
    expect(createSessionNavigatorProvider({ provider: 'codex', rootUri })).not.toBeInstanceOf(FileSessionNavigatorProvider);
  });
});
