import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/package/exports.test.mjs'],
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          include: ['test/browser/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
