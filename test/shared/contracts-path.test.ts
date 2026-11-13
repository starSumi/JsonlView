import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('canonical shared contracts path', () => {
  it('keeps shared/types.ts as a re-export-only compatibility barrel', () => {
    const legacyPath = resolve(import.meta.dirname, '../../src/shared/types.ts');
    const legacySource = readFileSync(legacyPath, 'utf8');

    expect(legacySource).toMatch(/export\s+\*\s+from\s+['"]\.\/contracts['"]/u);
    expect(legacySource).not.toMatch(/export\s+(?:interface|type|const|function|class|enum)\b/u);
  });
});
