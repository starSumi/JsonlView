import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('architecture boundary gate', () => {
  it('accepts the configured application and session dependency boundaries', () => {
    const output = execFileSync(process.execPath, ['scripts/check-architecture.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const result = JSON.parse(output) as {
      ok: boolean;
      checked?: { boundaryRules?: number };
    };

    expect(result.ok).toBe(true);
    expect(result.checked?.boundaryRules).toBeGreaterThanOrEqual(4);
  });
});
