import { transformSync } from '@babel/core';
import reactCompiler from 'babel-plugin-react-compiler';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const REACT_COMPILER_ENV = 'JSONLVIEW_REACT_COMPILER';

export function reactCompilerEnabled(environment = process.env) {
  return environment[REACT_COMPILER_ENV] === '1';
}

export function transformReactCompilerSource(source, filename) {
  const result = transformSync(source, {
    filename,
    ast: false,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    },
    plugins: [[reactCompiler, { compilationMode: 'annotation', target: '19' }]],
  });
  if (!result?.code) throw new Error(`React Compiler produced no output for ${filename}`);
  return result.code;
}

export function createReactCompilerPlugin({ rootDirectory, enabled = reactCompilerEnabled() }) {
  if (!enabled) return undefined;
  const webviewRoot = resolve(rootDirectory, 'src/webview');
  const allowedRoots = [
    resolve(webviewRoot, 'widgets/detail-drawer'),
    resolve(webviewRoot, 'features/record-query'),
  ];
  return {
    name: 'jsonlview-react-compiler',
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const absolutePath = resolve(args.path);
        const inAllowedRoot = allowedRoots.some((allowedRoot) => {
          const relativePath = relative(allowedRoot, absolutePath);
          return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
        });
        if (!inAllowedRoot) return undefined;
        const source = await readFile(absolutePath, 'utf8');
        return {
          contents: transformReactCompilerSource(source, absolutePath),
          loader: 'tsx',
          resolveDir: dirname(absolutePath),
        };
      });
    },
  };
}
