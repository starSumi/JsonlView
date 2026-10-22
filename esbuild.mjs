import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectExecutionIdentityInputs, createExecutionIdentity, createExecutionIdentityPlugin, finalizeExecutionBuild } from './scripts/execution-identity.mjs';
import { createReactCompilerPlugin } from './scripts/react-compiler.mjs';

const watch = process.argv.includes('--watch');
const production = !watch;
const outputDirectory = resolve(process.env.JSONLVIEW_DIST_OUTPUT ?? fileURLToPath(new URL('./dist/', import.meta.url)));
const rootDirectory = fileURLToPath(new URL('./', import.meta.url));
const buildMode = watch ? 'development' : 'production';
const buildIdentity = await createExecutionIdentity({ rootDirectory, buildMode });
const watchFiles = await collectExecutionIdentityInputs(rootDirectory);
const reactCompilerPlugin = createReactCompilerPlugin({ rootDirectory });

// Watch output is development-only: independent incremental rebuilds do not
// publish a frozen pair, manifest or byte inventory. Production shares one
// captured identity and revalidates the source after both compilers finish.
function identityPlugin() {
  if (!watch) return createExecutionIdentityPlugin({ identity: buildIdentity, watchFiles });
  return {
    name: 'jsonlview-development-identity',
    setup(api) {
      let roundIdentity = buildIdentity;
      api.initialOptions.banner = { js: '' };
      api.onStart(async () => { roundIdentity = await createExecutionIdentity({ rootDirectory, buildMode }); });
      api.onResolve({ filter: /^jsonlview:execution-identity$/ }, () => ({ path: 'development-identity', namespace: 'jsonlview-development-identity' }));
      api.onLoad({ filter: /.*/, namespace: 'jsonlview-development-identity' }, () => ({
        contents: `export default Object.freeze(${JSON.stringify(roundIdentity)});`, loader: 'js', watchFiles,
      }));
    },
  };
}

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
  plugins: [identityPlugin()],
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
  plugins: [identityPlugin(), ...(reactCompilerPlugin ? [reactCompilerPlugin] : [])],
};

const mcpServerOptions = {
  entryPoints: ['src/mcp-server.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: resolve(outputDirectory, 'mcp-server.cjs'),
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const extension = await context(extensionOptions);
  const webview = await context(webviewOptions);
  const mcpServer = await context(mcpServerOptions);
  await Promise.all([extension.watch(), webview.watch(), mcpServer.watch()]);
  console.log('JsonlView development build is watching; output is not a frozen production pair.');
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions), build(mcpServerOptions)]);
  await finalizeExecutionBuild({ rootDirectory, outputDirectory, identity: buildIdentity });
}
