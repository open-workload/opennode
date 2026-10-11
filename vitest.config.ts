import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'lib/*/src/**/*.test.ts',
      'artifacts/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./artifacts/api-server/src/test-setup.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 42,
        branches: 36,
        functions: 37,
        lines: 43,
      },
    },
  },
});
