import { expect, it } from 'vitest';

it('runs this suite on the Bun runtime', () => {
  // vitest.config.ts only collects test/bun when Bun executes the workers (`npm run test:bun`).
  expect(process.versions.bun).toMatch(/^\d+\.\d+\.\d+/);
  expect(typeof Bun.serve).toBe('function');
});
