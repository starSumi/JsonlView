import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseTargets } from './release-targets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requiredContractText = [
  '## Change Contract',
  '## Completion Levels',
  '## Decision Records',
  'JsonlView-harness',
  'pnpm check:contract',
];
const adrFiles = [
  '001-format-profile-boundary.md',
  '002-generations-and-follow.md',
  '003-native-acceleration.md',
  '004-webview-rendering.md',
  '005-release-provenance.md',
  '006-claude-surface-strategies.md',
  '007-source-backed-format-discovery.md',
  '008-promotion-synchronization.md',
  '009-automatic-update-boundary.md',
  '010-toolchain-baseline.md',
  '011-runtime-topology-and-refactor-shape.md',
  '012-registry-extension-identities.md',
];
const adrFields = [
  '## Pressure',
  '## Invariant',
  '## Owner',
  '## Alternatives',
  '## Probe',
  '## Decision',
  '## Evidence',
  '## Boundary',
  '## Revisit Trigger',
  '## Rollback',
];
const pinnedWorkflowActions = [
  {
    file: '.github/workflows/ci.yml',
    action: 'pnpm/action-setup',
    // v5 is an annotated tag; pin the peeled commit so GitHub receives an
    // immutable commit reference rather than the tag object itself.
    sha: 'fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  },
  {
    file: '.github/workflows/maintenance.yml',
    action: 'pnpm/action-setup',
    sha: 'fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  },
  {
    file: '.github/workflows/codeql.yml',
    action: 'github/codeql-action/init',
    sha: '3ea06614dafe36dec890db3446326e0d40ce53d4',
  },
  {
    file: '.github/workflows/codeql.yml',
    action: 'github/codeql-action/analyze',
    sha: '3ea06614dafe36dec890db3446326e0d40ce53d4',
  },
];

const failures = [];
const text = async (relativePath) => readFile(join(root, relativePath), 'utf8');
const exists = async (relativePath) => {
  try {
    await access(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
};

const agents = await text('AGENTS.md');
for (const marker of requiredContractText) {
  if (!agents.includes(marker)) failures.push(`AGENTS.md missing: ${marker}`);
}

for (const directory of ['report', 'showcase', 'harness']) {
  if (await exists(directory)) failures.push(`transient directory must stay in sibling harness: ${directory}`);
}

// Git ignore rules must not become a hiding place for release candidates or
// credentials. Build output such as dist/ remains allowed, but root-level
// installable bundles and authentication material belong in the harness or in
// an external release environment.
try {
  const rootEntries = await readdir(root, { withFileTypes: true });
  const forbiddenIgnored = rootEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((entry) => /^(?:[^/\\]+\.(?:vsix|tgz|provenance\.json)|\.env(?:\..*)?|\.npmrc|[^/\\]+\.(?:pem|key|p12|pfx))$/i.test(entry));
  for (const entry of forbiddenIgnored) {
    failures.push(`ignored release or credential material must stay outside product checkout: ${entry}`);
  }
} catch (error) {
  failures.push(`unable to inspect root release/credential material: ${error instanceof Error ? error.message : String(error)}`);
}

if (!(await exists('docs/decisions/README.md'))) failures.push('docs/decisions/README.md is missing');
for (const file of adrFiles) {
  const relative = join('docs/decisions', file);
  if (!(await exists(relative))) {
    failures.push(`decision record is missing: ${relative}`);
    continue;
  }
  const content = await text(relative);
  for (const field of adrFields) {
    if (!content.includes(field)) failures.push(`${relative} missing: ${field}`);
  }
}

for (const pin of pinnedWorkflowActions) {
  if (!(await exists(pin.file))) {
    failures.push(`workflow is missing: ${pin.file}`);
    continue;
  }
  const workflow = await text(pin.file);
  const escapedAction = pin.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const references = [...workflow.matchAll(new RegExp(`uses:\\s*${escapedAction}@([^\\s#]+)`, 'g'))]
    .map((match) => match[1]);
  if (references.length === 0) {
    failures.push(`${pin.file} has no ${pin.action} action reference`);
    continue;
  }
  for (const reference of references) {
    if (!/^[0-9a-f]{40}$/i.test(reference ?? '') || reference.toLowerCase() !== pin.sha) {
      failures.push(`${pin.file} must pin ${pin.action} to commit ${pin.sha}`);
    }
  }
}

const packageJson = JSON.parse(await text('package.json'));
for (const script of ['typecheck', 'test', 'test:coverage', 'build', 'check:contract', 'check:cargo-notices', 'generate:cargo-notices', 'check:runtime-notices', 'discover:producers', 'native:clippy', 'release:preflight', 'promotion:plan', 'promotion:join', 'sync:local', 'package:npm', 'package:vsix:candidate', 'verify:vsix-targets']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json missing script: ${script}`);
}

for (const helper of ['scripts/npm-tarball-integrity.mjs', 'scripts/vsix-archive-integrity.mjs', 'scripts/verify-candidate-pair.mjs', 'scripts/verify-vsix-targets.mjs', 'scripts/release-targets.mjs', 'scripts/promotion-join.mjs', 'scripts/license-policy.mjs']) {
  if (!(await exists(helper))) failures.push(`release helper is missing: ${helper}`);
}

try {
  const releaseTargets = await loadReleaseTargets();
  if (releaseTargets.sourceManifest.name !== packageJson.name) failures.push('release target source name differs from package.json');
  if (releaseTargets.sourceManifest.publisher !== packageJson.publisher) failures.push('release target source publisher differs from package.json');
  const openVsx = releaseTargets.extensions['open-vsx'];
  const marketplace = releaseTargets.extensions.marketplace;
  if (openVsx.name !== packageJson.name || openVsx.publisher !== packageJson.publisher) {
    failures.push('Open VSX target must preserve the source manifest update chain');
  }
  if (`${marketplace.publisher}.${marketplace.name}`.toLowerCase() === `${openVsx.publisher}.${openVsx.name}`.toLowerCase()) {
    failures.push('Marketplace and Open VSX extension targets must be distinct');
  }
  const contributionIds = [
    ...(packageJson.contributes?.commands ?? []).map((entry) => entry.command),
    ...(packageJson.contributes?.customEditors ?? []).map((entry) => entry.viewType),
    ...Object.keys(packageJson.contributes?.configuration?.properties ?? {}),
  ];
  for (const id of releaseTargets.sharedContributionIds) {
    if (!contributionIds.includes(id)) failures.push(`release target shared contribution is missing from package.json: ${id}`);
  }
  for (const id of contributionIds) {
    if (!releaseTargets.sharedContributionIds.includes(id)) failures.push(`package.json contribution is missing from the release target contract: ${id}`);
  }
  if (releaseTargets.coInstallSupported !== false) failures.push('target VSIX files cannot claim co-install support while contribution ids are shared');
} catch (error) {
  failures.push(`release target contract is invalid: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  failures.push('package.json must define an explicit npm files allowlist');
} else if (packageJson.files.some((entry) => /^(src|test|scripts|\.github|native\/jsonl-core\/src)(\/|$)/.test(entry))) {
  failures.push('package.json files allowlist includes development-only content');
}

const notices = await text('THIRD-PARTY-NOTICES.txt');
for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  if (!notices.includes(`${name} ${version}`)) {
    failures.push(`THIRD-PARTY-NOTICES.txt is missing direct runtime dependency: ${name}@${version}`);
  }
}
if (notices.trim().length === 0) failures.push('THIRD-PARTY-NOTICES.txt is empty or malformed');

const nativeDeclaration = await text('native/jsonl-core/index.d.ts');
for (const signature of [
  'export declare function abiVersion(): number;',
  'export declare function capabilities(): number;',
  'export declare function scanLf(input: Uint8Array, start: number, limit: number): Uint32Array;',
]) {
  if (!nativeDeclaration.includes(signature)) failures.push(`native/jsonl-core/index.d.ts is missing: ${signature}`);
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: { adrFiles: adrFiles.length, requiredContractMarkers: requiredContractText.length } }));
}
