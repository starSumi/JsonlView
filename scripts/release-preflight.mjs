import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, lstat, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { bundleFromCandidateInventory, compareBundleInventories } from './bundle-integrity.mjs';
import { compareNpmFileInventories, inspectNpmTarball } from './npm-tarball-integrity.mjs';
import { isApprovedPublicLicense, validateProjectLicense } from './license-policy.mjs';
import { compareReleaseLegalInventories, inventorySourceLegalFiles, selectReleaseLegalInventory } from './release-legal-integrity.mjs';
import { computeSourceManifest, validateProvenanceSourceBinding } from './verify-native-provenance.mjs';
import { compareVsixArchiveIdentity, compareVsixArchiveIdentityEvidence, inspectVsixArchive } from './vsix-archive-integrity.mjs';
import { getExtensionTarget, getReleaseTargets, resolveExtensionTarget } from './release-targets.mjs';
import { canonicalVsixPairEvidence, computeVsixPairSha256, verifyVsixTargetEvidence } from './verify-vsix-targets.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SEMVER_PATTERN = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const CREDENTIAL_CONTENT_PATTERNS = [
  // npm's current access-token format is `npm_` plus exactly 36 characters.
  // Keep the boundaries aligned with the upstream Secretlint npm rule so
  // standard environment names such as npm_execpath are not false positives.
  ['npm-token', /(?<!\p{L})npm_[A-Za-z0-9_]{36}(?![A-Za-z0-9_])/u],
  ['open-vsx-token', /ovsxat_[A-Za-z0-9_-]{8,}/],
  ['github-token', /(?:ghp_|github_pat_)[A-Za-z0-9_-]{8,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
let failures = [];
let warnings = [];
let checks = {};

if (isMainModule()) await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  failures = [];
  warnings = [];
  checks = {};
  const canonicalNpmName = getReleaseTargets().npm.name;

  if (!options.public) fail('mode', 'release preflight requires --public; staging is not a release gate');
  const npmIdentityIssue = approvedNpmNameIssue(options.approvedNpmName, options.public);
  if (npmIdentityIssue !== undefined) fail('npmIdentity', npmIdentityIssue);
  if (options.public && options.npmTarball === undefined) {
    fail('npmIdentity', 'public release requires --npm-tarball <exact reviewed .tgz>');
  }
  if (options.public && options.vsixTarget === undefined) {
    fail('vsixIdentity', 'public release requires --vsix-target <open-vsx|marketplace>');
  }
  if (options.public && (options.vsixPairReport === undefined || options.pairedVsixArtifact === undefined)) {
    fail('vsixPair', 'public release requires --vsix-pair-report and --paired-vsix-artifact');
  }

  const packageJson = await readJson(resolve(root, 'package.json'), 'package.json');
  const licenseText = await readFile(resolve(root, 'LICENSE.txt'), 'utf8');
  const sourceLegalFiles = await inventorySourceLegalFiles(root);
  const packageIdentity = checkPublicPackage(packageJson, licenseText);
  const extensionTarget = options.vsixTarget === undefined ? undefined : await resolveExtensionTarget(options.vsixTarget);
  const gitIdentity = await checkGitIdentity();
  const revision = gitIdentity.revision;
  checkOriginRepository(packageIdentity.repository, gitIdentity);
  await checkTrackedSecrets();

  let nativeProvenance;
  if (options.provenance === undefined) {
    fail('nativeProvenance', 'pass --provenance <full committed-vs-rebuilt report>');
  } else {
    nativeProvenance = await checkNativeProvenance(options.provenance, gitIdentity);
  }
  let npmCandidate;
  if (options.npmManifest === undefined) {
    fail('npmCandidate', 'pass --npm-manifest <prepared npm candidate manifest>');
  } else {
    npmCandidate = await checkNpmManifest(options.npmManifest, options.npmCandidate, options.npmTarball, revision, gitIdentity, options.approvedNpmName, nativeProvenance, sourceLegalFiles);
  }
  if (options.vsixManifest === undefined) {
    fail('vsixCandidate', 'pass --vsix-manifest <packaged VSIX manifest>');
  } else {
    await checkVsixManifest(options.vsixManifest, options.vsixArtifact, revision, gitIdentity, packageIdentity, extensionTarget, npmCandidate, options.approvedNpmName, nativeProvenance, sourceLegalFiles);
  }
  if (options.vsixPairReport !== undefined && options.pairedVsixArtifact !== undefined
    && options.vsixArtifact !== undefined && options.vsixTarget !== undefined) {
    await checkVsixPairEvidence(options.vsixPairReport, options.vsixArtifact, options.pairedVsixArtifact, options.vsixTarget);
  }

  const outputPath = options.out === undefined ? undefined : resolve(options.out);
  if (outputPath !== undefined && !isOutsideProductCheckout(outputPath)) {
    fail('report', 'preflight report must be outside the product checkout');
  }

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    mode: 'public-release',
    ok: failures.length === 0,
    checks,
    failures,
    warnings,
  };
  if (outputPath !== undefined && !failures.some((failure) => failure.check === 'report')) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function checkPublicPackage(manifest, licenseText) {
  const validation = validatePackageIdentity(manifest, {
    requireName: true,
    requirePublisher: true,
    requireVersion: true,
    requirePrivate: true,
    requireLicense: true,
    requireRepository: true,
    publicRelease: true,
  });
  for (const issue of validation.issues) fail(`package.${issue.field}`, issue.message);
  const licenseValidation = validateProjectLicense(manifest?.license, licenseText);
  for (const issue of licenseValidation.issues) fail('package.licenseText', issue);
  checks.package = {
    ...validation.identity,
  };
  return validation.identity;
}

async function checkGitIdentity() {
  const [revisionResult, statusResult, diffResult, remotesResult] = await Promise.all([
    gitResult(['rev-parse', 'HEAD']),
    gitResult(['status', '--porcelain=v1', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }),
    gitResult(['diff', '--no-ext-diff', '--binary', 'HEAD'], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    }),
    gitResult(['remote', '-v']),
  ]);
  const revision = typeof revisionResult?.stdout === 'string' ? revisionResult.stdout.trim() : '';
  const status = resultBuffer(statusResult);
  const diff = resultBuffer(diffResult);
  const statusAvailable = status !== undefined;
  const diffAvailable = diff !== undefined;
  const gitState = statusAvailable
    ? status.toString('utf8').trim().length === 0 ? 'clean' : 'dirty'
    : 'unknown';
  const statusSha256 = statusAvailable ? digest(status) : 'unavailable';
  const diffSha256 = diffAvailable ? digest(diff) : 'unavailable';
  const remotes = typeof remotesResult?.stdout === 'string' ? remotesResult.stdout : '';
  const remoteUrls = parseRemoteUrls(remotes);
  const origin = remoteUrls.origin ?? {};
  if (!/^[0-9a-f]{40}$/i.test(revision)) fail('git.revision', 'HEAD is not a full commit id');
  if (gitState !== 'clean') fail('git.clean', 'working tree is dirty or its state could not be read; freeze and review the exact candidate first');
  if (remotesResult === undefined || Object.keys(remoteUrls).length === 0) fail('git.remote', 'no Git remote is configured; public provenance cannot be read back');
  if (origin.fetch === undefined && origin.push === undefined) fail('git.remote.origin', 'the origin remote is missing; package.repository cannot be verified');
  checks.git = {
    revision,
    gitState,
    workingTreeClean: gitState === 'clean',
    statusSha256,
    diffSha256,
    remoteConfigured: Object.keys(remoteUrls).length > 0,
    origin: {
      fetch: normalizeRepositoryIdentity(origin.fetch),
      push: normalizeRepositoryIdentity(origin.push),
    },
  };
  return {
    revision,
    gitState,
    statusSha256,
    diffSha256,
    remoteUrls,
    originUrl: origin.fetch ?? origin.push,
  };
}

function checkOriginRepository(packageRepository, gitIdentity) {
  if (packageRepository === undefined) return;
  const expected = packageRepository;
  const origin = gitIdentity.remoteUrls?.origin ?? {};
  const observed = [origin.fetch, origin.push].filter((value) => value !== undefined);
  if (observed.length === 0) return;
  const mismatches = observed
    .map((value) => ({ kind: value === origin.fetch ? 'fetch' : 'push', value, normalized: normalizeRepositoryIdentity(value) }))
    .filter((entry) => entry.normalized === undefined || entry.normalized !== expected);
  if (mismatches.length > 0) {
    fail('git.remote.repository', 'origin URL does not match package.repository; verify the repository owner and path before promotion');
  }
  checks.git.repository = {
    package: expected,
    origin: observed.map((value) => normalizeRepositoryIdentity(value) ?? '<invalid>'),
    match: mismatches.length === 0,
  };
}

async function checkTrackedSecrets() {
  const raw = await git(['ls-files', '-z']);
  const paths = raw.split('\0').filter(Boolean);
  const findings = [];
  const filenamePattern = /(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)|\.npmrc)$/i;
  for (const relativePath of paths) {
    if (filenamePattern.test(relativePath)) findings.push({ path: relativePath, kind: 'sensitive-filename' });
    const path = resolve(root, relativePath);
    let content;
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.size > 2 * 1024 * 1024) continue;
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    for (const kind of findCredentialKinds(content)) {
      findings.push({ path: relativePath, kind });
    }
  }
  if (findings.length > 0) fail('trackedSecrets', 'tracked files contain credential-like names or tokens; rotate and remove before release');
  checks.trackedSecrets = { clean: findings.length === 0, findings };
}

export function findCredentialKinds(content) {
  if (typeof content !== 'string') return [];
  return CREDENTIAL_CONTENT_PATTERNS
    .filter(([, pattern]) => pattern.test(content))
    .map(([kind]) => kind);
}

async function checkNativeProvenance(path, gitIdentity) {
  const report = await readJson(resolve(path), 'native provenance report');
  const comparison = report.comparison ?? {};
  const repository = report.repository ?? {};
  const currentSource = await computeSourceManifest();
  const sourceBinding = validateProvenanceSourceBinding(report, {
    gitSha: gitIdentity?.revision,
    sourceDigest: currentSource.sha256,
  });
  if (report.ok !== true) fail('nativeProvenance.ok', 'native provenance report did not pass');
  if (comparison.committedBinaryChecked !== true) fail('nativeProvenance.committed', 'release requires committed-vs-rebuilt native comparison');
  if (comparison.contractEqual !== true || comparison.behaviorEqual !== true) fail('nativeProvenance.behavior', 'native ABI or behavior comparison failed');
  if (comparison.noPrivatePathMarkers !== true) fail('nativeProvenance.paths', 'native binary contains private path markers');
  if (repository.workingTreeClean !== true) fail('nativeProvenance.clean', 'native provenance was captured from a dirty checkout');
  if (!sourceBinding.repositoryHeadMatchesCurrent) fail('nativeProvenance.revision', 'native provenance commit does not match the current checkout HEAD');
  if (!sourceBinding.sourceDigestMatchesCurrent) fail('nativeProvenance.source', 'native provenance source digest does not match the current native source tree');
  if (!sourceBinding.sourceManifestMatchesReport) fail('nativeProvenance.source', 'native provenance source manifest and comparison digest disagree');
  const rebuiltSha256 = report.binaries?.rebuilt?.sha256;
  if (!SHA256_PATTERN.test(rebuiltSha256 ?? '')) fail('nativeProvenance.digest', 'native provenance has no rebuilt binary SHA-256 digest');
  checks.nativeProvenance = {
    ok: report.ok === true,
    committedBinaryChecked: comparison.committedBinaryChecked === true,
    contractEqual: comparison.contractEqual === true,
    behaviorEqual: comparison.behaviorEqual === true,
    sourceDigest: comparison.sourceDigest ?? 'unknown',
    repositoryHeadMatchesCurrent: sourceBinding.repositoryHeadMatchesCurrent,
    sourceDigestMatchesCurrent: sourceBinding.sourceDigestMatchesCurrent,
    sourceManifestMatchesReport: sourceBinding.sourceManifestMatchesReport,
    rebuiltSha256: rebuiltSha256 ?? 'unknown',
  };
  return {
    rebuiltSha256,
    sourceDigest: sourceBinding.sourceDigestMatchesCurrent && sourceBinding.sourceManifestMatchesReport
      ? comparison.sourceDigest
      : undefined,
  };
}

async function checkNpmManifest(manifestPath, candidatePath, tarballPath, revision, gitIdentity, approvedNpmName, nativeProvenance, sourceLegalFiles) {
  const manifest = await readJson(resolve(manifestPath), 'npm candidate manifest');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!isApprovedPublicLicense(manifest.package?.license)) fail('npmCandidate.license', 'npm candidate does not carry an approved public license');
  const sourceValidation = requireSourceProvenance(manifest.source, gitIdentity, 'npmCandidate.source', 'npmCandidate.provenance');
  const packageValidation = validatePackageIdentity(manifest.package, {
    requireName: true,
    requireVersion: true,
    requireLicense: true,
    requireRepository: true,
  });
  for (const issue of packageValidation.issues) fail(`npmCandidate.package.${issue.field}`, issue.message);
  if (approvedNpmName !== undefined && packageValidation.identity.name !== approvedNpmName) {
    fail('npmCandidate.identity', `npm candidate name must exactly match the approved package identity (${approvedNpmName})`);
  }
  if (files.length === 0) fail('npmCandidate.files', 'npm candidate has no file inventory');

  let tarball;
  let tarballIntegrity = false;
  if (tarballPath === undefined) {
    fail('npmCandidate.tarball', 'pass --npm-tarball <exact prepared .tgz> so the published bytes can be re-inspected');
  } else if (!isOutsideProductCheckout(tarballPath)) {
    fail('npmCandidate.tarball', 'npm tarball must be outside the product checkout');
  } else {
    const failureCountBeforeTarball = failures.length;
    try {
      await assertNoSymlinkAncestor(resolve(tarballPath));
      tarball = await inspectNpmTarball(resolve(tarballPath));
      const expectedArtifact = manifest.tarball?.artifact ?? manifest.tarball ?? {};
      if (tarball.artifact.bytes !== expectedArtifact.bytes) fail('npmCandidate.tarball', 'npm tarball byte count differs from the sidecar manifest');
      if (typeof expectedArtifact.sha256 !== 'string' || tarball.artifact.sha256.toLowerCase() !== expectedArtifact.sha256.toLowerCase()) {
        fail('npmCandidate.tarball', 'npm tarball SHA-256 differs from the sidecar manifest');
      }
      if (manifest.tarball?.inventorySha256 !== undefined
        && tarball.inventorySha256.toLowerCase() !== String(manifest.tarball.inventorySha256).toLowerCase()) {
        fail('npmCandidate.tarball', 'npm tarball inventory digest differs from the sidecar manifest');
      }
      for (const issue of compareNpmFileInventories(files, tarball.files)) fail('npmCandidate.tarball', issue);
      for (const field of ['name', 'version', 'publisher', 'license', 'private']) {
        if (tarball.packageJson[field] !== manifest.package?.[field]) {
          fail('npmCandidate.tarballIdentity', `npm tarball package.json ${field} differs from the sidecar identity`);
        }
      }
      if (normalizeRepositoryIdentity(repositoryUrl(tarball.packageJson.repository)) !== packageValidation.identity.repository) {
        fail('npmCandidate.tarballIdentity', 'npm tarball package.json repository differs from the sidecar identity');
      }
      tarballIntegrity = failures.length === failureCountBeforeTarball;
    } catch (error) {
      fail('npmCandidate.tarball', `cannot inspect the exact npm tarball: ${errorMessage(error)}`);
    }
  }

  const authoritativeFiles = tarball?.files ?? files;
  for (const issue of compareReleaseLegalInventories(
    sourceLegalFiles,
    selectReleaseLegalInventory(authoritativeFiles),
    'npm tarball',
  )) fail('npmCandidate.legal', issue);
  const nativeDigestIssues = compareNativeCandidateDigests({
    provenance: nativeProvenance?.rebuiltSha256,
    npmManifest: manifest.native?.candidateSha256,
    npmInventory: authoritativeFiles.find((file) => normalizeInventoryPath(file?.path) === 'native/jsonl-core/jsonl_core.win32-x64-msvc.node')?.sha256,
  });
  for (const issue of nativeDigestIssues) fail('npmCandidate.native', issue);
  if (manifest.native?.sourceDigest !== nativeProvenance?.sourceDigest) {
    fail('npmCandidate.native', 'npm candidate native source digest does not match the approved provenance report');
  }
  const npmBundle = bundleFromCandidateInventory(authoritativeFiles);
  for (const issue of compareBundleInventories(manifest.bundle, npmBundle)) fail('npmCandidate.bundle', issue);
  const forbidden = authoritativeFiles
    .map((file) => normalizeInventoryPath(file?.path));
  const forbiddenPaths = findForbiddenDistributionPaths(forbidden);
  if (forbiddenPaths.length > 0) fail('npmCandidate.scope', `npm candidate contains development or sensitive paths: ${forbiddenPaths.join(', ')}`);

  let integrity;
  if (candidatePath !== undefined && !isOutsideProductCheckout(candidatePath)) {
    fail('npmCandidate.path', 'npm candidate must be outside the product checkout');
  } else if (candidatePath !== undefined) {
    integrity = await verifyNpmCandidateIntegrity(resolve(candidatePath), files);
    if (!integrity.ok) fail('npmCandidate.integrity', formatIntegrityFailure(integrity));
  }
  checks.npmCandidate = {
    package: packageValidation.identity,
    approvedName: approvedNpmName,
    files: authoritativeFiles.length,
    clean: sourceValidation.ok,
    source: {
      gitSha: manifest.source?.gitSha,
      gitState: manifest.source?.gitState,
      statusSha256: manifest.source?.statusSha256,
      diffSha256: manifest.source?.diffSha256,
      matchesCurrent: sourceValidation.ok,
    },
    ...(integrity === undefined ? {} : {
      actualFiles: integrity.actualFiles,
      inventorySha256: integrity.inventorySha256,
    }),
    integrity: tarballIntegrity && (integrity === undefined || integrity.ok),
    nativeSha256: manifest.native?.candidateSha256,
    bundle: npmBundle,
    ...(tarball === undefined ? {} : {
      tarball: {
        bytes: tarball.artifact.bytes,
        sha256: tarball.artifact.sha256,
        inventorySha256: tarball.inventorySha256,
      },
    }),
  };
  return {
    package: packageValidation.identity,
    source: manifest.source,
    nativeSha256: manifest.native?.candidateSha256,
    bundle: npmBundle,
    files: authoritativeFiles,
    tarball,
  };
}

async function checkVsixManifest(manifestPath, artifactPath, revision, gitIdentity, rootPackage, extensionTarget, npmCandidate, approvedNpmName, nativeProvenance, sourceLegalFiles) {
  const manifest = await readJson(resolve(manifestPath), 'VSIX candidate manifest');
  const artifact = manifest.artifact ?? {};
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) fail('vsixCandidate.artifact', 'VSIX manifest has no positive artifact size');
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256 ?? '')) fail('vsixCandidate.digest', 'VSIX manifest has no SHA-256 digest');
  const sourceValidation = requireSourceProvenance(manifest.source, gitIdentity, 'vsixCandidate.source', 'vsixCandidate.provenance');
  const packageValidation = validatePackageIdentity(manifest.package, {
    requireName: true,
    requirePublisher: true,
    requireVersion: true,
    requirePrivate: true,
    requireLicense: true,
    requireRepository: true,
    publicRelease: true,
  });
  for (const issue of packageValidation.issues) fail(`vsixCandidate.package.${issue.field}`, issue.message);
  const expectedTargetPackage = extensionTarget === undefined ? rootPackage : {
    ...rootPackage,
    name: extensionTarget.name,
    displayName: extensionTarget.displayName,
    publisher: extensionTarget.publisher,
  };
  const identityIssues = comparePackageIdentities(packageValidation.identity, expectedTargetPackage, ['name', 'publisher', 'version', 'private', 'license', 'repository']);
  if (extensionTarget !== undefined && manifest.package?.displayName !== extensionTarget.displayName) {
    identityIssues.push('displayName differs from the selected extension release target');
  }
  if (extensionTarget !== undefined && (manifest.releaseTarget?.key !== extensionTarget.key
    || manifest.releaseTarget?.extensionId?.toLowerCase() !== `${extensionTarget.publisher}.${extensionTarget.name}`.toLowerCase())) {
    identityIssues.push('VSIX sidecar releaseTarget differs from the selected extension release target');
  }
  for (const issue of identityIssues) fail('vsixCandidate.package.identity', issue);
  const npmIdentityIssues = compareNpmCandidateIdentity(packageValidation.identity, npmCandidate?.package, approvedNpmName);
  for (const issue of npmIdentityIssues) fail('candidates.identity', issue);
  const npmSourceIssues = compareSourceProvenance(manifest.source, npmCandidate?.source);
  for (const issue of npmSourceIssues) fail('candidates.provenance', issue);

  let integrity;
  let embeddedNative;
  let embeddedBundle;
  let archiveIdentity;
  let archiveEntries;
  let archiveLegalFiles;
  let archiveFiles;
  if (artifactPath === undefined) {
    fail('vsixCandidate.path', 'pass --vsix-artifact <packaged VSIX file> so the artifact digest can be rechecked');
  } else if (!isOutsideProductCheckout(artifactPath)) {
    fail('vsixCandidate.path', 'VSIX artifact must be outside the product checkout');
  } else {
    try {
      await assertNoSymlinkAncestor(resolve(artifactPath));
      const archive = await inspectVsixArchive(resolve(artifactPath));
      embeddedNative = archive.native;
      embeddedBundle = archive.bundle;
      archiveIdentity = archive.identity;
      archiveEntries = archive.entries;
      archiveLegalFiles = archive.legal?.files;
      archiveFiles = archive.files;
      const integrityIssues = [];
      if (archive.artifact.bytes !== artifact.bytes) integrityIssues.push({ kind: 'size-mismatch', path: '<artifact>' });
      if (typeof artifact.sha256 !== 'string' || archive.artifact.sha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
        integrityIssues.push({ kind: 'digest-mismatch', path: '<artifact>' });
      }
      integrity = {
        ok: integrityIssues.length === 0,
        actualBytes: archive.artifact.bytes,
        actualSha256: archive.artifact.sha256,
        issues: integrityIssues,
      };
      if (!integrity.ok) fail('vsixCandidate.integrity', formatIntegrityFailure(integrity));
    } catch (error) {
      fail('vsixCandidate.archive', `cannot inspect the finished VSIX archive: ${errorMessage(error)}`);
    }
  }
  for (const issue of compareReleaseLegalInventories(sourceLegalFiles, archiveLegalFiles, 'VSIX archive')) {
    fail('vsixCandidate.legal', issue);
  }
  const forbiddenVsixPaths = findForbiddenDistributionPaths(archiveFiles?.map((file) => file.path), 'extension/');
  if (forbiddenVsixPaths.length > 0) {
    fail('vsixCandidate.scope', `VSIX contains development or sensitive paths: ${forbiddenVsixPaths.join(', ')}`);
  }
  const unexpectedVsixPaths = findUnexpectedVsixDistributionPaths(archiveFiles?.map((file) => file.path));
  if (unexpectedVsixPaths.length > 0) {
    fail('vsixCandidate.scope', `VSIX contains files outside the release allowlist: ${unexpectedVsixPaths.join(', ')}`);
  }
  if (archiveIdentity !== undefined) {
    for (const issue of compareVsixArchiveIdentity(archiveIdentity, manifest.package, 'sidecar package')) {
      fail('vsixCandidate.archiveIdentity', issue);
    }
    for (const issue of compareVsixArchiveIdentity(archiveIdentity, expectedTargetPackage, 'release target package')) {
      fail('vsixCandidate.archiveIdentity', issue);
    }
    for (const issue of compareVsixArchiveIdentityEvidence(archiveIdentity, manifest.archiveIdentity)) {
      fail('vsixCandidate.archiveIdentity', issue);
    }
  }
  const nativeDigestIssues = compareNativeCandidateDigests({
    provenance: nativeProvenance?.rebuiltSha256,
    npmCandidate: npmCandidate?.nativeSha256,
    vsixManifest: manifest.native?.candidateSha256,
    vsixManifestEmbedded: manifest.native?.embeddedSha256,
    vsixArchive: embeddedNative?.sha256,
  });
  for (const issue of nativeDigestIssues) fail('vsixCandidate.native', issue);
  for (const issue of compareBundleInventories(manifest.bundle, npmCandidate?.bundle, embeddedBundle)) {
    fail('candidates.bundle', issue);
  }
  checks.vsixCandidate = {
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
    source: {
      gitSha: manifest.source?.gitSha,
      gitState: manifest.source?.gitState,
      statusSha256: manifest.source?.statusSha256,
      diffSha256: manifest.source?.diffSha256,
      matchesCurrent: sourceValidation.ok,
    },
    package: packageValidation.identity,
    target: extensionTarget === undefined ? null : {
      key: extensionTarget.key,
      registry: extensionTarget.registry,
      extensionId: `${extensionTarget.publisher}.${extensionTarget.name}`,
      displayName: extensionTarget.displayName,
      preservesUpdateChain: extensionTarget.preservesUpdateChain,
    },
    identityMatchesPackage: identityIssues.length === 0,
    identityMatchesNpm: npmIdentityIssues.length === 0,
    archiveIdentity,
    archiveEntries: archiveEntries?.count,
    nativeSha256: embeddedNative?.sha256 ?? manifest.native?.embeddedSha256,
    bundleSha256: embeddedBundle?.sha256 ?? manifest.bundle?.sha256,
    ...(integrity === undefined ? {} : { integrity: integrity.ok, actualBytes: integrity.actualBytes, actualSha256: integrity.actualSha256 }),
  };
}

async function checkVsixPairEvidence(reportPath, currentArtifactPath, pairedArtifactPath, selectedTarget) {
  if (![reportPath, currentArtifactPath, pairedArtifactPath].every(isOutsideProductCheckout)) {
    fail('vsixPair.path', 'pair report and both VSIX artifacts must be outside the product checkout');
    return;
  }
  try {
    const [recorded, current, paired] = await Promise.all([
      readJson(resolve(reportPath), 'VSIX pair report'),
      inspectVsixArchive(resolve(currentArtifactPath)),
      inspectVsixArchive(resolve(pairedArtifactPath)),
    ]);
    const openVsxTarget = getExtensionTarget('open-vsx');
    const marketplaceTarget = getExtensionTarget('marketplace');
    const evidence = selectedTarget === 'open-vsx'
      ? verifyVsixTargetEvidence({ openVsx: current, marketplace: paired }, { openVsxTarget, marketplaceTarget })
      : verifyVsixTargetEvidence({ openVsx: paired, marketplace: current }, { openVsxTarget, marketplaceTarget });
    if (!evidence.ok) fail('vsixPair.equality', evidence.failures.join('; '));
    const recordedPairSha256 = typeof recorded?.pairSha256 === 'string' ? recorded.pairSha256.toLowerCase() : undefined;
    const computedPairSha256 = computeVsixPairSha256(evidence);
    if (recordedPairSha256 !== computedPairSha256
      || pairEvidenceSignature(recorded) !== pairEvidenceSignature(evidence)) {
      fail('vsixPair.report', 'VSIX pair report does not match the exact supplied artifacts');
    }
    const selectedKey = selectedTarget === 'open-vsx' ? 'openVsx' : 'marketplace';
    checks.vsixPair = {
      ok: evidence.ok
        && recordedPairSha256 === computedPairSha256
        && pairEvidenceSignature(recorded) === pairEvidenceSignature(evidence),
      pairSha256: computedPairSha256,
      selectedTarget,
      selected: evidence.targets[selectedKey],
      targets: evidence.targets,
      sharedPayload: evidence.sharedPayload,
      allowedIdentityDifferences: evidence.allowedIdentityDifferences,
    };
  } catch (error) {
    fail('vsixPair', `cannot verify paired VSIX evidence: ${errorMessage(error)}`);
  }
}

function pairEvidenceSignature(value) {
  return JSON.stringify(canonicalVsixPairEvidence(value));
}

/** All supplied native digests must be valid and name the same binary. */
export function compareNativeCandidateDigests(values) {
  const entries = Object.entries(values ?? {});
  const issues = [];
  if (entries.length === 0) return ['native digest evidence is missing'];
  for (const [label, value] of entries) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) issues.push(`${label} native digest is missing or malformed`);
  }
  const valid = entries.filter(([, value]) => typeof value === 'string' && SHA256_PATTERN.test(value));
  const distinct = new Set(valid.map(([, value]) => value.toLowerCase()));
  if (distinct.size > 1) issues.push(`native binary digests differ across ${valid.map(([label]) => label).join(', ')}`);
  return issues;
}

/**
 * Validate the package identity copied into a candidate manifest. The release
 * gate deliberately validates this independently from the source package so a
 * staging script cannot silently package a different publisher or revision.
 */
export function validatePackageIdentity(value, options = {}) {
  const issues = [];
  const packageValue = isRecord(value) ? value : {};
  const identity = {
    name: typeof packageValue.name === 'string' ? packageValue.name : undefined,
    publisher: typeof packageValue.publisher === 'string' ? packageValue.publisher : undefined,
    version: typeof packageValue.version === 'string' ? packageValue.version : undefined,
    private: typeof packageValue.private === 'boolean' ? packageValue.private : undefined,
    license: typeof packageValue.license === 'string' ? packageValue.license : undefined,
    repository: normalizeRepositoryIdentity(repositoryUrl(packageValue.repository)),
  };

  validateStringField(packageValue, 'name', options.requireName === true, PACKAGE_NAME_PATTERN, 'a valid package name', issues);
  validateStringField(packageValue, 'publisher', options.requirePublisher === true, PUBLISHER_PATTERN, 'a valid VS Code publisher', issues);
  validateStringField(packageValue, 'version', options.requireVersion === true, SEMVER_PATTERN, 'a valid semver version', issues);

  if (options.requirePrivate === true && !Object.hasOwn(packageValue, 'private')) {
    issues.push({ field: 'private', message: 'candidate package must record a boolean private field' });
  } else if (Object.hasOwn(packageValue, 'private') && typeof packageValue.private !== 'boolean') {
    issues.push({ field: 'private', message: 'candidate package private must be boolean' });
  }
  if (options.publicRelease === true && packageValue.private !== false) {
    issues.push({ field: 'private', message: 'candidate package must set private=false for a public release' });
  }

  if (options.requireLicense === true && !Object.hasOwn(packageValue, 'license')) {
    issues.push({ field: 'license', message: 'candidate package must record an approved public license' });
  } else if (Object.hasOwn(packageValue, 'license') && !isApprovedPublicLicense(packageValue.license)) {
    issues.push({ field: 'license', message: `candidate package license is not approved for this public release (observed ${String(packageValue.license)})` });
  }

  const repository = repositoryUrl(packageValue.repository);
  if (options.requireRepository === true && repository === undefined) {
    issues.push({ field: 'repository', message: 'candidate package must record an HTTPS repository URL' });
  } else if (repository !== undefined && (!/^https:\/\//i.test(repository) || identity.repository === undefined)) {
    issues.push({ field: 'repository', message: 'candidate package repository must be a valid HTTPS repository URL' });
  }
  if (options.publicRelease === true && packageValue.publisher === 'momo') {
    issues.push({ field: 'publisher', message: 'development publisher "momo" cannot be promoted' });
  }
  return { ok: issues.length === 0, issues, identity };
}

function validateStringField(value, field, required, pattern, description, issues) {
  const present = Object.hasOwn(value, field);
  if (!present && required) {
    issues.push({ field, message: `candidate package must record ${field}` });
    return;
  }
  if (present && (typeof value[field] !== 'string' || !pattern.test(value[field]))) {
    issues.push({ field, message: `candidate package ${field} must be ${description}` });
  }
}

/** Compare only fields that are present in both candidate identities. */
export function comparePackageIdentities(left, right, fields = ['name', 'publisher', 'version', 'private', 'license', 'repository']) {
  if (!isRecord(left) || !isRecord(right)) return [];
  const issues = [];
  for (const field of fields) {
    if (left[field] === undefined || right[field] === undefined) continue;
    if (left[field] !== right[field]) issues.push(`${field} differs between candidate manifests`);
  }
  return issues;
}

/**
 * npm and VS Code extension coordinates are independent public identities.
 * Compare their shared version and ownership fields, while binding the npm
 * name to the separately approved exact package name.
 */
export function compareNpmCandidateIdentity(vsix, npm, approvedNpmName) {
  if (!isRecord(vsix) || !isRecord(npm)) return [];
  const issues = [];
  if (approvedNpmName !== undefined && npm.name !== approvedNpmName) {
    issues.push('npm candidate name does not match the approved package identity');
  }
  if (vsix.version !== undefined && npm.version !== undefined && vsix.version !== npm.version) {
    issues.push('version differs between VSIX and npm candidates');
  }
  for (const field of ['publisher', 'private', 'license', 'repository']) {
    if (vsix[field] !== undefined && npm[field] !== undefined && vsix[field] !== npm[field]) {
      issues.push(`${field} differs between VSIX and npm candidates`);
    }
  }
  return issues;
}

export function approvedNpmNameIssue(value, required = true) {
  const canonicalNpmName = getReleaseTargets().npm.name;
  if (value === undefined) {
    return required
      ? 'public release requires --approved-npm-name <exact npm package name> (or JSONLVIEW_APPROVED_NPM_NAME)'
      : undefined;
  }
  if (!PACKAGE_NAME_PATTERN.test(value)) return 'approved npm package name must be a valid exact npm package name';
  if (value !== canonicalNpmName) return `approved npm package name must match the release target contract (${canonicalNpmName})`;
  return undefined;
}

/**
 * Check a VSIX source snapshot against the live checkout. Hashes are over the
 * exact git command output used by package-vsix-candidate, not a trimmed view.
 */
export function validateSourceProvenance(source, current, label = 'source') {
  const issues = [];
  if (!isRecord(source)) {
    issues.push(`${label} is missing`);
    return { ok: false, issues };
  }
  if (!/^[0-9a-f]{40}$/i.test(source.gitSha ?? '')) issues.push(`${label} is not tied to a full commit id`);
  if (source.gitState !== 'clean') issues.push(`${label} was captured from a dirty checkout`);
  if (!SHA256_PATTERN.test(source.statusSha256 ?? '')) issues.push(`${label}.statusSha256 is missing or invalid`);
  if (!SHA256_PATTERN.test(source.diffSha256 ?? '')) issues.push(`${label}.diffSha256 is missing or invalid`);
  if (isRecord(current)) {
    if (/^[0-9a-f]{40}$/i.test(current.revision) && source.gitSha?.toLowerCase() !== current.revision.toLowerCase()) {
      issues.push(`${label} commit does not match the current checkout HEAD`);
    }
    if (current.gitState !== undefined && source.gitState !== current.gitState) {
      issues.push(`${label} gitState does not match the current checkout`);
    }
    if (SHA256_PATTERN.test(current.statusSha256 ?? '') && source.statusSha256?.toLowerCase() !== current.statusSha256.toLowerCase()) {
      issues.push(`${label} status digest does not match the current checkout`);
    }
    if (SHA256_PATTERN.test(current.diffSha256 ?? '') && source.diffSha256?.toLowerCase() !== current.diffSha256.toLowerCase()) {
      issues.push(`${label} diff digest does not match the current checkout`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Convert source validation into gate findings so no caller can silently discard issues. */
export function collectSourceProvenanceFailures(source, current, label, check) {
  const validation = validateSourceProvenance(source, current, label);
  return {
    validation,
    failures: validation.issues.map((message) => ({ check, message })),
  };
}

/** Reject internal, credential-like, and release-evidence files from public archives. */
export function findForbiddenDistributionPaths(paths, prefix = '') {
  if (!Array.isArray(paths)) return ['<missing-inventory>'];
  const normalizedPrefix = prefix.replaceAll('\\', '/');
  const forbidden = [];
  for (const value of paths) {
    if (typeof value !== 'string') {
      forbidden.push('<invalid-path>');
      continue;
    }
    const normalized = value.replaceAll('\\', '/');
    const path = normalized.startsWith(normalizedPrefix) ? normalized.slice(normalizedPrefix.length) : normalized;
    if (/^(?:src|test|scripts|\.github|report|showcase|harness)(?:\/|$)/i.test(path)
      || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|p12|pfx)|.*\.provenance\.json)$/i.test(path)) {
      forbidden.push(normalized);
    }
  }
  return [...new Set(forbidden)].sort(stableCompare);
}

/** The VSIX has a deliberately small public surface; reject every other file. */
export function findUnexpectedVsixDistributionPaths(paths) {
  if (!Array.isArray(paths)) return ['<missing-inventory>'];
  return paths
    .filter((path) => typeof path !== 'string' || !isAllowedVsixPath(path.replaceAll('\\', '/')))
    .map((path) => typeof path === 'string' ? path : '<invalid-path>')
    .sort(stableCompare);
}

function isAllowedVsixPath(path) {
  if (path === '[Content_Types].xml' || path === 'extension.vsixmanifest') return true;
  if (!path.startsWith('extension/')) return false;
  const relativePath = path.slice('extension/'.length);
  const foldedPath = relativePath.toLowerCase();
  if (['package.json', 'readme.md', 'changelog.md', 'license.txt', 'third-party-notices.txt'].includes(foldedPath)) return true;
  if (['dist/extension.cjs', 'dist/webview.css', 'dist/webview.js'].includes(foldedPath)) return true;
  if (['native/jsonl-core/jsonl_core.win32-x64-msvc.node', 'native/jsonl-core/index.d.ts', 'native/jsonl-core/package.json'].includes(foldedPath)) return true;
  if (['docs/acceleration-roadmap.md', 'docs/format-and-profile-boundaries.md'].includes(foldedPath)) return true;
  return /^(?:docs\/assets|docs\/decisions|third_party\/licenses)\/.+/i.test(relativePath);
}

function requireSourceProvenance(source, current, label, check) {
  const result = collectSourceProvenanceFailures(source, current, label, check);
  for (const finding of result.failures) fail(finding.check, finding.message);
  return result.validation;
}

/** Compare provenance snapshots when both npm and VSIX candidates provide one. */
export function compareSourceProvenance(left, right) {
  if (!isRecord(left) || !isRecord(right)) return [];
  const issues = [];
  for (const field of ['gitSha', 'gitState', 'statusSha256', 'diffSha256']) {
    if (left[field] === undefined || right[field] === undefined) continue;
    if (left[field] !== right[field]) issues.push(`${field} differs between candidate manifests`);
  }
  return issues;
}

export function normalizeRepositoryIdentity(value) {
  if (typeof value !== 'string') return undefined;
  let source = value.trim();
  if (source.length === 0) return undefined;
  const scp = source.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  let host;
  let path;
  if (scp !== null) {
    host = scp[1];
    path = scp[2];
  } else {
    source = source.replace(/^git\+/i, '');
    let parsed;
    try { parsed = new URL(source); } catch { return undefined; }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
  }
  if (typeof host !== 'string' || typeof path !== 'string') return undefined;
  path = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (path.length === 0 || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.url === 'string') return value.url;
  return undefined;
}

function parseRemoteUrls(value) {
  const remotes = {};
  for (const line of String(value).split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (match === null) continue;
    const [, name, url, kind] = match;
    remotes[name] ??= {};
    remotes[name][kind] = url;
  }
  return remotes;
}

function resultBuffer(result) {
  if (result === undefined) return undefined;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '', 'utf8');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkManifestRevision(value, revision, check) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    fail(check, 'candidate manifest is not tied to a full commit id');
    return;
  }
  if (/^[0-9a-f]{40}$/i.test(revision) && value.toLowerCase() !== revision.toLowerCase()) {
    fail(check, 'candidate manifest commit does not match the current checkout HEAD');
  }
}

/**
 * Re-walk an npm candidate and compare every byte count and SHA-256 digest with
 * the frozen manifest inventory. The returned paths are always candidate-
 * relative, so release evidence never needs to expose a local checkout path.
 */
export async function verifyNpmCandidateIntegrity(candidatePath, expectedFiles) {
  const issues = [];
  const expected = normalizeExpectedInventory(expectedFiles, issues);
  let actual = [];
  try {
    await assertNoSymlinkAncestor(candidatePath);
    actual = await inventoryCandidate(candidatePath);
  } catch (error) {
    issues.push({ kind: 'candidate-unreadable', path: '<candidate>', detail: errorMessage(error) });
  }

  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of expected) {
    const observed = actualByPath.get(entry.path);
    if (observed === undefined) {
      issues.push({ kind: 'missing-file', path: entry.path });
      continue;
    }
    if (observed.bytes !== entry.bytes) issues.push({ kind: 'size-mismatch', path: entry.path });
    if (observed.sha256.toLowerCase() !== entry.sha256.toLowerCase()) issues.push({ kind: 'digest-mismatch', path: entry.path });
  }
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path)) issues.push({ kind: 'unexpected-file', path: entry.path });
  }
  return {
    ok: issues.length === 0,
    expectedFiles: expected.length,
    actualFiles: actual.length,
    inventorySha256: inventoryDigest(actual),
    issues: issues.slice(0, 64),
  };
}

/** Re-hash the exact VSIX file named by a release manifest. */
export async function verifyVsixArtifactIntegrity(artifactPath, expectedArtifact) {
  const issues = [];
  const expectedBytes = expectedArtifact?.bytes;
  const expectedSha256 = expectedArtifact?.sha256;
  let actual;
  try {
    await assertNoSymlinkAncestor(artifactPath);
    actual = await hashRegularFile(artifactPath);
  } catch (error) {
    issues.push({ kind: 'artifact-unreadable', path: '<artifact>', detail: errorMessage(error) });
  }
  if (actual !== undefined) {
    if (actual.bytes !== expectedBytes) issues.push({ kind: 'size-mismatch', path: '<artifact>' });
    if (typeof expectedSha256 !== 'string' || actual.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      issues.push({ kind: 'digest-mismatch', path: '<artifact>' });
    }
  }
  return {
    ok: issues.length === 0,
    actualBytes: actual?.bytes,
    actualSha256: actual?.sha256,
    issues: issues.slice(0, 16),
  };
}

function normalizeExpectedInventory(files, issues) {
  if (!Array.isArray(files)) return [];
  const normalized = [];
  const paths = new Set();
  for (const value of files) {
    if (value === null || typeof value !== 'object') {
      issues.push({ kind: 'invalid-inventory-entry', path: '<entry>' });
      continue;
    }
    const entry = value;
    const path = normalizeInventoryPath(entry.path);
    const bytes = entry.bytes;
    const sha256 = entry.sha256;
    if (path === undefined || !Number.isSafeInteger(bytes) || bytes < 0 || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      issues.push({ kind: 'invalid-inventory-entry', path: typeof entry.path === 'string' ? entry.path : '<entry>' });
      continue;
    }
    if (paths.has(path)) {
      issues.push({ kind: 'duplicate-inventory-path', path });
      continue;
    }
    paths.add(path);
    normalized.push({ path, bytes, sha256 });
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeInventoryPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.includes('\0')) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  return normalized;
}

async function inventoryCandidate(directory) {
  const details = await lstat(directory, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('candidate must be a regular directory');
  const entries = [];
  await walkCandidate(directory, '', entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertNoSymlinkAncestor(path) {
  let cursor = resolve(path);
  while (true) {
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) throw new Error('candidate path has a symbolic-link ancestor');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function walkCandidate(directory, prefix, entries) {
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const absolute = resolve(directory, child.name);
    if (child.isSymbolicLink()) throw new Error(`candidate contains a symbolic link at ${path}`);
    if (child.isDirectory()) {
      await walkCandidate(absolute, path, entries);
      continue;
    }
    if (!child.isFile()) throw new Error(`candidate contains a non-regular entry at ${path}`);
    const digest = await hashRegularFile(absolute);
    entries.push({ path, ...digest });
  }
}

async function hashRegularFile(path) {
  const pathBefore = await lstat(path, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) throw new Error('path is not a regular file');
  if (pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('file is larger than the safe size limit');

  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFileStat(pathBefore, before)) throw new Error('file changed before hashing');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const remaining = before.size - offset;
      const requested = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead <= 0) throw new Error('unexpected end of file while hashing');
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameFileStat(before, after) || !sameFileStat(before, pathAfter)) throw new Error('file changed while hashing');
    return { bytes: Number(offset), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sameFileStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function inventoryDigest(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${String(entry.bytes)}\0${entry.sha256.toLowerCase()}\n`);
  return hash.digest('hex');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatIntegrityFailure(result) {
  const details = result.issues
    .slice(0, 8)
    .map((issue) => `${issue.kind}:${String(issue.path).slice(0, 160)}`)
    .join(', ');
  const omitted = Math.max(0, result.issues.length - 8);
  return `candidate contents do not match the frozen manifest${details.length === 0 ? '' : ` (${details}${omitted > 0 ? `, +${String(omitted)} more` : ''})`}`;
}

function isOutsideProductCheckout(path) {
  const resolved = resolve(path);
  const relativePath = relative(root, resolved);
  return isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`);
}

async function readJson(path, label) {
  try {
    await access(path);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(label, `cannot read or parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function git(args) {
  try {
    const result = await execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    fail(`git.${args[0]}`, error instanceof Error ? error.message : String(error));
    return '';
  }
}

async function gitResult(args, options = {}) {
  try {
    return await execFile('git', args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    fail(`git.${args[0]}`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function fail(check, message) {
  failures.push({ check, message });
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(args) {
  args = stripLeadingScriptSeparator(args);
  const parsed = {
    public: false,
    approvedNpmName: process.env.JSONLVIEW_APPROVED_NPM_NAME?.trim() || undefined,
    provenance: undefined,
    npmManifest: undefined,
    npmCandidate: undefined,
    npmTarball: undefined,
    vsixManifest: undefined,
    vsixArtifact: undefined,
    vsixTarget: process.env.JSONLVIEW_VSIX_TARGET?.trim() || undefined,
    vsixPairReport: undefined,
    pairedVsixArtifact: undefined,
    out: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--public') {
      parsed.public = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--approved-npm-name') parsed.approvedNpmName = value;
    else if (key === '--provenance') parsed.provenance = value;
    else if (key === '--npm-manifest') parsed.npmManifest = value;
    else if (key === '--npm-candidate') parsed.npmCandidate = value;
    else if (key === '--npm-tarball') parsed.npmTarball = value;
    else if (key === '--vsix-manifest') parsed.vsixManifest = value;
    else if (key === '--vsix-artifact') parsed.vsixArtifact = value;
    else if (key === '--vsix-target') parsed.vsixTarget = value;
    else if (key === '--vsix-pair-report') parsed.vsixPairReport = value;
    else if (key === '--paired-vsix-artifact') parsed.pairedVsixArtifact = value;
    else if (key === '--out') parsed.out = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (parsed.vsixTarget !== undefined && !['open-vsx', 'marketplace'].includes(parsed.vsixTarget)) {
    throw new Error(`invalid extension release target: ${parsed.vsixTarget}`);
  }
  return parsed;
}

/**
 * pnpm can forward its script separator as argv[0] on some invocation forms.
 * Consume exactly one leading separator; a second one remains invalid input
 * and is reported by the parser instead of being silently discarded.
 */
export function stripLeadingScriptSeparator(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

export { parseArgs };

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
