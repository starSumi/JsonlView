import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'jsonlview:execution-identity': fileURLToPath(new URL('./test/support/execution-identity.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
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
