import { createHash } from 'node:crypto';

export const APPROVED_PUBLIC_LICENSES = Object.freeze(['MIT', 'Apache-2.0']);

const MIT_BODY_SHA256 = '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3';
const APACHE_2_SHA256 = 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2';
const PROJECT_COPYRIGHT = 'Copyright (c) 2026 Sumi-Sophia';

export function isApprovedPublicLicense(value) {
  return APPROVED_PUBLIC_LICENSES.includes(value);
}

/**
 * Validate the repository license against the exact reviewed standard text.
 * This deliberately accepts only the two licenses offered to the owner; a
 * string that merely looks like an SPDX id is not release evidence.
 */
export function validateProjectLicense(license, contents) {
  const issues = [];
  if (!isApprovedPublicLicense(license)) {
    issues.push(`license must be one of ${APPROVED_PUBLIC_LICENSES.join(', ')}`);
    return { ok: false, issues };
  }
  if (typeof contents !== 'string' || contents.length === 0) {
    return { ok: false, issues: ['LICENSE.txt is missing or empty'] };
  }
  const normalized = normalizeLicenseText(contents);
  if (license === 'Apache-2.0') {
    if (sha256(normalized) !== APACHE_2_SHA256) issues.push('LICENSE.txt is not the exact reviewed Apache License 2.0 text');
    return { ok: issues.length === 0, issues };
  }

  const [copyright, ...remaining] = normalized.split('\n');
  if (copyright !== PROJECT_COPYRIGHT) issues.push(`MIT LICENSE.txt must begin with ${PROJECT_COPYRIGHT}`);
  const body = remaining.join('\n').replace(/^\n+/, '');
  if (sha256(body) !== MIT_BODY_SHA256) issues.push('LICENSE.txt is not the exact reviewed MIT license text');
  return { ok: issues.length === 0, issues };
}

export function normalizeLicenseText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trimEnd()
    .concat('\n');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
