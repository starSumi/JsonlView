// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { isApprovedPublicLicense, validateProjectLicense } from '../../scripts/license-policy.mjs';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public license policy', () => {
  it('allows only the two owner-facing license choices', () => {
    expect(isApprovedPublicLicense('MIT')).toBe(true);
    expect(isApprovedPublicLicense('Apache-2.0')).toBe(true);
    expect(isApprovedPublicLicense('NOT-A-REAL-SPDX-ID')).toBe(false);
    expect(isApprovedPublicLicense('UNLICENSED')).toBe(false);
  });

  it('accepts the exact reviewed standard texts', async () => {
    const licenseDirectory = resolve('third_party/licenses');
    const mit = await readFile(resolve(licenseDirectory, 'bitflags-2.13.1-LICENSE-MIT.txt'), 'utf8');
    const apache = await readFile(resolve(licenseDirectory, 'bitflags-2.13.1-LICENSE-APACHE.txt'), 'utf8');
    const projectMit = mit.replace(/^Copyright[^\r\n]*/, 'Copyright (c) 2026 Sumi-Sophia');
    expect(validateProjectLicense('MIT', projectMit)).toMatchObject({ ok: true });
    expect(validateProjectLicense('Apache-2.0', apache)).toMatchObject({ ok: true });
  });

  it('rejects proprietary text and appended restrictions', async () => {
    const mit = await readFile(resolve('third_party/licenses/bitflags-2.13.1-LICENSE-MIT.txt'), 'utf8');
    const projectMit = mit.replace(/^Copyright[^\r\n]*/, 'Copyright (c) 2026 Sumi-Sophia');
    expect(validateProjectLicense('MIT', 'Copyright (c) 2026. All rights reserved.')).toMatchObject({ ok: false });
    expect(validateProjectLicense('MIT', `${projectMit}\nNo commercial use.\n`)).toMatchObject({ ok: false });
  });
});
