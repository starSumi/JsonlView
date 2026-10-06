// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { buildEncodedRustflags } from '../../scripts/build-native.mjs';
import { describe, expect, it } from 'vitest';

describe('native build flags', () => {
  it('adds the MSVC reproducibility flag before path remaps', () => {
    expect(buildEncodedRustflags(
      ['-C', 'target-cpu=native'],
      [['E:/workspace', '<workspace>']],
      true,
    )).toEqual([
      '-C',
      'target-cpu=native',
      '-C',
      'link-arg=/Brepro',
      '--remap-path-prefix=E:/workspace=<workspace>',
    ]);
  });

  it('does not add the MSVC flag for non-MSVC targets', () => {
    expect(buildEncodedRustflags(
      [],
      [['/workspace', '<workspace>']],
      false,
    )).toEqual(['--remap-path-prefix=/workspace=<workspace>']);
  });

  it('does not duplicate an inherited /Brepro flag', () => {
    expect(buildEncodedRustflags(
      ['-C', 'link-arg=/Brepro'],
      [],
      true,
    )).toEqual(['-C', 'link-arg=/Brepro']);
  });
});
