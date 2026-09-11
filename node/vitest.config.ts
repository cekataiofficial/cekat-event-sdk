import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,mjs}'],
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
