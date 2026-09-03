import { describe, expect, it } from 'vitest';
import { displayFieldPath, keyPath } from '../../src/shared/types';

describe('field path display', () => {
  it('preserves keys that contain dots', () => {
    expect(displayFieldPath(keyPath('payload', 'a.b'))).toBe('$.payload["a.b"]');
  });
});

