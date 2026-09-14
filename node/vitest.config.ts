import { defineConfig } from 'vitest/config';

// test/bun uses Bun-only APIs such as Bun.serve; it is collected only when Bun runs the workers
// (`npm run test:bun`). Every other suite runs on both Node.js and Bun.
const bunOnly = 'test/bun/**/*.test.ts';
const onBun = process.versions.bun !== undefined;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/package/exports.test.mjs'],
    exclude: ['**/node_modules/**', ...(onBun ? [] : [bunOnly])],
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
