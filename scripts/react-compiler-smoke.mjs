import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createReactCompilerPlugin, reactCompilerEnabled, transformReactCompilerSource } from './react-compiler.mjs';

assert.equal(reactCompilerEnabled({}), false);
assert.equal(reactCompilerEnabled({ JSONLVIEW_REACT_COMPILER: '1' }), true);

const fixture = `import React from 'react';
type Props = { value: string };
export function CompilerFixture({ value }: Props) {
  "use memo";
  return <div>{value}</div>;
}`;
const compiled = transformReactCompilerSource(fixture, 'react-compiler-smoke.tsx');
assert.match(compiled, /react\/compiler-runtime/);
assert.match(compiled, /type Props/);

const bundled = await transform(compiled, { loader: 'tsx', format: 'esm', target: 'es2022' });
assert.match(bundled.code, /react\/compiler-runtime/);
assert.match(bundled.code, /CompilerFixture/);

let onLoad;
const plugin = createReactCompilerPlugin({
  rootDirectory: fileURLToPath(new URL('../', import.meta.url)),
  enabled: true,
});
plugin.setup({ onLoad(_options, handler) { onLoad = handler; } });
const targetPath = resolve(fileURLToPath(new URL('../', import.meta.url)), 'src/webview/widgets/detail-drawer/detail-drawer.tsx');
const target = await onLoad({ path: targetPath });
assert.equal(target?.loader, 'tsx');
assert.match(target?.contents ?? '', /react\/compiler-runtime/);
const outside = await onLoad({ path: resolve(fileURLToPath(new URL('../', import.meta.url)), 'src/webview/App.tsx') });
assert.equal(outside, undefined);
console.log('React Compiler TSX smoke passed (Babel annotation transform, esbuild TSX parse, and whitelist gate).');
