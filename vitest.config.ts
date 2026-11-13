import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('./', import.meta.url));
const tsconfigPath = fileURLToPath(new URL('./tsconfig.json', import.meta.url));
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};
const pathAliases = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions?.paths ?? {}).flatMap(([pattern, targets]) => {
    const target = targets[0];
    if (target === undefined) return [];
    const alias = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    const replacement = target.endsWith('/*') ? target.slice(0, -2) : target;
    return [[alias, resolve(projectRoot, replacement)]];
  }),
);

export default defineConfig({
  resolve: {
    alias: {
      ...pathAliases,
      'jsonlview:execution-identity': fileURLToPath(new URL('./test/support/execution-identity.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    pool: 'threads',
    maxWorkers: 2,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        statements: 65,
        branches: 55,
        functions: 65,
        lines: 68,
      },
    },
  },
});
