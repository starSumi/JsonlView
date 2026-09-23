import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const production = !watch;
const outputDirectory = resolve(process.env.JSONLVIEW_DIST_OUTPUT ?? fileURLToPath(new URL('./dist/', import.meta.url)));

await rm(outputDirectory, { recursive: true, force: true });

const extensionOptions = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: resolve(outputDirectory, 'extension.cjs'),
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const webviewOptions = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: resolve(outputDirectory, 'webview.js'),
  sourcemap: !production,
  minify: production,
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
  logLevel: 'info',
};

if (watch) {
  const extension = await context(extensionOptions);
  const webview = await context(webviewOptions);
  await Promise.all([extension.watch(), webview.watch()]);
  console.log('JsonlView build is watching for changes.');
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions)]);
}
