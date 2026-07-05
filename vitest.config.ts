import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'core/test/**/*.test.ts',
      'aal/test/**/*.test.ts',
      'adapters/test/**/*.test.ts',
      'console/backend/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
    passWithNoTests: true,
  },
});
