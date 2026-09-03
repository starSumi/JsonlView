import { describe, expect, it } from 'vitest';
import { shouldAutoFollow } from '../../src/extension/follow-policy';

describe('follow source policy', () => {
  it('automatically follows only verified appends', () => {
    expect(shouldAutoFollow('append')).toBe(true);
    expect(shouldAutoFollow('unchanged')).toBe(false);
    expect(shouldAutoFollow('truncate')).toBe(false);
    expect(shouldAutoFollow('replace')).toBe(false);
    expect(shouldAutoFollow('delete')).toBe(false);
    expect(shouldAutoFollow('unknown')).toBe(false);
  });
});
