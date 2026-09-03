import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = !watch;

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });

const extensionOptions = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.cjs',
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
  outfile: 'dist/webview.js',
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
