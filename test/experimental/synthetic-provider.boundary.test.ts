import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('synthetic provider runtime boundary', () => {
  it('does not acquire product, filesystem, process, network, database, or MCP capabilities', async () => {
    const source = await readFile(new URL('../../src/experimental/synthetic-provider.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:vscode|node:fs|node:fs\/promises|node:child_process|node:net|node:http|node:https|node:sqlite|better-sqlite3)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|spawn|execFile|createConnection)\s*\(/u);
    expect(source).not.toMatch(/[A-Za-z]:[\\/].*(?:codex|claude|session|prompt)/iu);
  });
});
