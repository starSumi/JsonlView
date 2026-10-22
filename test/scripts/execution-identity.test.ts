import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { build, type PluginBuild } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The execution identity helper is intentionally plain ESM for build-time use.
import { canonicalJson, createExecutionIdentity, createExecutionIdentityPlugin, extractRuntimeExecutionIdentity, finalizeExecutionBuild, finalizeExecutionIdentity, renderExecutionIdentityBinding, verifyBuiltExecutionIdentity, verifyBuiltExecutionIdentityForSource, verifyExecutionReceipt, writeExecutionBundleInventory, writeExecutionIdentityManifest } from '../../scripts/execution-identity.mjs';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'jsonlview-execution-identity-'));
  temporaryDirectories.push(directory);
  return directory;
}

function bundleSource(identity: unknown) {
  return `${renderExecutionIdentityBinding(identity)}\nconst runtimeIdentity=__JSONLVIEW_EXECUTION_IDENTITY_V1__;`;
}

async function artifact(directory: string, identity: unknown) {
  await mkdir(directory, { recursive: true });
  await writeExecutionIdentityManifest(directory, identity);
  for (const name of ['extension.cjs', 'webview.js']) await writeFile(resolve(directory, name), bundleSource(identity));
  await writeFile(resolve(directory, 'webview.css'), 'body{color:inherit}');
  await writeExecutionBundleInventory(directory, identity);
}

async function selectedSource() {
  const root = await temporaryDirectory();
  await mkdir(resolve(root, 'src'));
  await mkdir(resolve(root, 'scripts'));
  for (const path of ['esbuild.mjs', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/execution-identity.mjs', 'scripts/react-compiler.mjs']) await writeFile(resolve(root, path), '{}');
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ publisher: 'Synthetic', name: 'fixture', version: '1.0.0' }));
  await writeFile(resolve(root, '.gitignore'), 'dist/\n');
  await writeFile(resolve(root, 'src/index.ts'), "import identity from 'jsonlview:execution-identity'; export {identity};");
  const git = (args: string[]) => execFileAsync('git', args, { cwd: root, windowsHide: true });
  await git(['init']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'core.hooksPath=', 'commit', '-m', 'synthetic fixture']);
  const identity = await createExecutionIdentity({ rootDirectory: root, buildMode: 'production' });
  const dist = resolve(root, 'dist');
  await artifact(dist, identity);
  return { root, dist, identity };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function payload() {
  return {
    schemaVersion: 'jsonlview.execution-identity.v1',
    extensionId: 'Sumi-Sophia.jsonl-view',
    extensionVersion: '0.2.11',
    buildMode: 'test',
    compilerMode: 'disabled',
    sourceRevision: '0'.repeat(40),
    sourceState: 'modified',
    buildInputsSha256: '1'.repeat(64),
    buildInputCount: 1,
    digestAlgorithm: 'sha256',
    canonicalization: 'jsonlview.sorted-json.v1',
  };
}

describe('execution identity build evidence', () => {
  it('canonicalizes object key order before deriving the manifest digest', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}');
    expect(finalizeExecutionIdentity(payload())).toEqual(finalizeExecutionIdentity({ ...payload() }));
  });

  it('rejects digest text in a comment followed by throw rather than a runtime binding', async () => {
    const directory = await temporaryDirectory();
    const identity = finalizeExecutionIdentity(payload());
    await artifact(directory, identity);
    await writeFile(resolve(directory, 'webview.js'), `// ${identity.manifestSha256}\nthrow Error('no runtime');`);
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('missing its canonical runtime');
  });

  it('verifies a matching artifact without requiring private source inputs', async () => {
    const directory = await temporaryDirectory();
    const identity = finalizeExecutionIdentity(payload());
    await artifact(directory, identity);
    await expect(verifyBuiltExecutionIdentity(directory)).resolves.toEqual(identity);
    await writeFile(resolve(directory, 'execution-identity.json'), JSON.stringify({ ...identity, sourceRevision: 'f'.repeat(40) }));
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('manifest digest is invalid');
    await writeExecutionIdentityManifest(directory, finalizeExecutionIdentity({ ...payload(), schemaVersion: 'unknown' }));
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('manifest shape is invalid');
  });

  it('rejects a changed runtime field even when the old digest text is retained', async () => {
    const directory = await temporaryDirectory();
    const identity = finalizeExecutionIdentity(payload());
    await artifact(directory, identity);
    const text = bundleSource(identity).replace(identity.sourceRevision, 'f'.repeat(40));
    await writeFile(resolve(directory, 'extension.cjs'), text);
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('manifest digest is invalid');
  });

  it('rejects duplicated and unused bindings and noncanonical duplicate JSON fields', () => {
    const identity = finalizeExecutionIdentity(payload());
    const binding = renderExecutionIdentityBinding(identity);
    expect(() => extractRuntimeExecutionIdentity(`${bundleSource(identity)} {${binding}}`)).toThrow('duplicated or unused');
    for (const duplicate of [
      'function shadow({x:__JSONLVIEW_EXECUTION_IDENTITY_V1__}){}',
      'const shadow=function __JSONLVIEW_EXECUTION_IDENTITY_V1__(){};',
      'try{}catch(__JSONLVIEW_EXECUTION_IDENTITY_V1__){}',
    ]) expect(() => extractRuntimeExecutionIdentity(`${bundleSource(identity)} ${duplicate}`)).toThrow('duplicated or unused');
    expect(() => extractRuntimeExecutionIdentity(binding)).toThrow('duplicated or unused');
    expect(() => extractRuntimeExecutionIdentity(`${binding} const unrelated={__JSONLVIEW_EXECUTION_IDENTITY_V1__:1};`)).toThrow('duplicated or unused');
    const duplicate = bundleSource(identity).replace('{"buildInputCount":', '{"buildInputCount":1,"buildInputCount":');
    expect(() => extractRuntimeExecutionIdentity(duplicate)).toThrow('not canonical');
  });

  it('requires the generated strict directive before the first identity statement', () => {
    const source = bundleSource(finalizeExecutionIdentity(payload()));
    expect(() => extractRuntimeExecutionIdentity(source.replace('"use strict";', ''))).toThrow('controlled strict directive');
    expect(() => extractRuntimeExecutionIdentity('"use strict";' + source)).toThrow('controlled strict directive');
  });

  it('rejects a mixed pair with a independently valid identity', async () => {
    const directory = await temporaryDirectory();
    const identity = finalizeExecutionIdentity(payload());
    await artifact(directory, identity);
    const other = finalizeExecutionIdentity({ ...payload(), sourceRevision: 'f'.repeat(40) });
    await writeFile(resolve(directory, 'webview.js'), bundleSource(other));
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('runtime identity differs from manifest');
  });

  it('checks an independent inventory of actual bundle bytes without self hashing', async () => {
    const directory = await temporaryDirectory();
    const identity = finalizeExecutionIdentity(payload());
    await artifact(directory, identity);
    await writeFile(resolve(directory, 'webview.js'), bundleSource(identity) + '\n// changed bytes');
    await expect(verifyBuiltExecutionIdentity(directory)).rejects.toThrow('inventory differs');
  });

  it('rejects stale frozen dist and preserves source identity apart from a target package identity', async () => {
    const { root, dist, identity } = await selectedSource();
    await expect(verifyBuiltExecutionIdentityForSource({ rootDirectory: root, distDirectory: dist })).resolves.toEqual(identity);
    const targetPackage = { name: '@different/registry-target', version: '1.0.0' };
    expect(targetPackage.name).not.toEqual(identity.extensionId);
    await writeFile(resolve(root, 'src/new.ts'), 'export const newInput=1;');
    await expect(verifyBuiltExecutionIdentityForSource({ rootDirectory: root, distDirectory: dist })).rejects.toThrow('selected source');
  });

  it('rejects nonproduction and modified-source release candidates', async () => {
    const { root, dist } = await selectedSource();
    const dev = await createExecutionIdentity({ rootDirectory: root, buildMode: 'development' });
    await artifact(dist, dev);
    await expect(verifyBuiltExecutionIdentityForSource({ rootDirectory: root, distDirectory: dist })).rejects.toThrow('production build from clean source');
    await writeFile(resolve(root, 'src/new.ts'), 'export const newInput=1;');
    const modified = await createExecutionIdentity({ rootDirectory: root, buildMode: 'production' });
    await artifact(dist, modified);
    await expect(verifyBuiltExecutionIdentityForSource({ rootDirectory: root, distDirectory: dist })).rejects.toThrow('production build from clean source');
  });

  it('shares a build round binding and fails closed if an input changes during compilation', async () => {
    const { root, dist, identity } = await selectedSource();
    await rm(dist, { recursive: true, force: true });
    await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, format: 'cjs', outfile: resolve(dist, 'extension.cjs'),
      plugins: [createExecutionIdentityPlugin({ identity }), { name: 'deterministic-source-change', setup(api: PluginBuild) {
        api.onEnd(async () => { await writeFile(resolve(root, 'src/changed.ts'), 'export const changed=true;'); });
      } }] });
    await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, format: 'iife', outfile: resolve(dist, 'webview.js'),
      plugins: [createExecutionIdentityPlugin({ identity })] });
    expect(extractRuntimeExecutionIdentity(await readFile(resolve(dist, 'extension.cjs'), 'utf8'))).toEqual(identity);
    expect(extractRuntimeExecutionIdentity(await readFile(resolve(dist, 'webview.js'), 'utf8'))).toEqual(identity);
    await expect(finalizeExecutionBuild({ rootDirectory: root, outputDirectory: dist, identity })).rejects.toThrow('selected source');
    await expect(readFile(resolve(dist, 'execution-identity.json'))).rejects.toThrow();
  });

  it.each(['cjs', 'iife'] as const)('executes trusted generated %s fixture to check the generator import connection', async (format) => {
    const { root, dist, identity } = await selectedSource();
    const outfile = resolve(dist, `trusted-fixture-${format}.js`);
    await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, minify: true, format, outfile,
      ...(format === 'iife' ? { globalName: 'SyntheticIdentityFixture' } : {}),
      plugins: [createExecutionIdentityPlugin({ identity })] });
    // Only this test-owned synthetic entry is executed. The artifact verifier
    // never evaluates user bundles; vm is not an untrusted-code sandbox.
    const context = { module: { exports: {} as { identity?: unknown } }, SyntheticIdentityFixture: undefined as { identity: unknown } | undefined };
    runInNewContext(await readFile(outfile, 'utf8'), context, { timeout: 1000, microtaskMode: 'afterEvaluate' });
    const consumed = format === 'cjs' ? context.module.exports.identity : context.SyntheticIdentityFixture?.identity;
    expect(consumed).toEqual(identity);
  });

  it.each(['cjs', 'iife'] as const)('preserves strict receiver and undeclared-assignment behavior in %s with and without the plugin', async (format) => {
    const identity = finalizeExecutionIdentity(payload());
    for (const withIdentity of [false, true]) {
      const output = await build({ stdin: { contents: '"use strict"; export function receiver(){return function(){return this;}();} export function undeclared(){__jsonlview_strict_fixture__=1;}', loader: 'js' },
        bundle: true, minify: true, write: false, format,
        ...(format === 'iife' ? { globalName: 'SyntheticStrictFixture' } : {}),
        plugins: withIdentity ? [createExecutionIdentityPlugin({ identity })] : [] });
      type StrictFixture = { receiver: () => unknown; undeclared: () => void };
      const context = { module: { exports: {} as StrictFixture }, SyntheticStrictFixture: undefined as StrictFixture | undefined };
      runInNewContext(output.outputFiles[0]!.text, context, { timeout: 1000, microtaskMode: 'afterEvaluate' });
      const fixture = format === 'cjs' ? context.module.exports : context.SyntheticStrictFixture!;
      expect(fixture.receiver()).toBeUndefined();
      expect(() => fixture.undeclared()).toThrow('__jsonlview_strict_fixture__ is not defined');
      expect(Object.hasOwn(context, '__jsonlview_strict_fixture__')).toBe(false);
    }
  });

  it.each(['production', 'development', 'test'])('verifies a production bundle with independently pinned %s host evidence', (extensionMode) => {
    const identity = finalizeExecutionIdentity({ ...payload(), buildMode: 'production' });
    const runtime = { extensionId: identity.extensionId, extensionVersion: identity.extensionVersion, extensionMode };
    expect(verifyExecutionReceipt({ executionIdentity: identity, runtimeIdentity: runtime }, identity, runtime))
      .toEqual({ executionIdentity: identity, runtimeIdentity: runtime });
    expect(() => verifyExecutionReceipt({ executionIdentity: identity }, identity, runtime)).toThrow();
    expect(() => verifyExecutionReceipt({ runtimeIdentity: runtime }, identity, runtime)).toThrow();
    expect(() => verifyExecutionReceipt({ executionIdentity: identity, runtimeIdentity: { ...runtime, extensionMode: 'unknown' } }, identity, runtime)).toThrow();
    expect(() => verifyExecutionReceipt({ executionIdentity: identity, runtimeIdentity: { ...runtime, extensionVersion: '9.9.9' } }, identity, runtime)).toThrow('does not match');
    expect(() => verifyExecutionReceipt({ executionIdentity: finalizeExecutionIdentity({ ...payload(), buildMode: 'development' }), runtimeIdentity: runtime }, identity, runtime)).toThrow('does not match');
  });
});
