import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('phase 2 isolation boundary', () => {
  it('has no filesystem, host, MCP, Monaco, or product-runtime imports', () => {
    const sourcePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../experimental/staged-mutation/index.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/(?:node:fs|from ['"]fs['"]|from ['"]vscode['"]|mcp|monaco)/i);
    expect(source).not.toMatch(/(?:writeFile|appendFile|rename|replaceFile|createWriteStream|open\()/);
  });
});
