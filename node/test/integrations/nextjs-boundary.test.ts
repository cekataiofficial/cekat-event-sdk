import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const nodeRoot = resolve(import.meta.dirname, '../..');

describe('Next.js adapter package boundary', () => {
  it('publishes nextjs only as a Node-only adapter and exposes no Edge entrypoint', async () => {
    const packageJson = JSON.parse(await readFile(resolve(nodeRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const nextjsEntries = Object.keys(packageJson.exports).filter((entry) => entry.startsWith('./nextjs'));
    const adapterSource = await readFile(resolve(nodeRoot, 'src/integrations/nextjs.ts'), 'utf8');

    expect(nextjsEntries).toEqual(['./nextjs']);
    expect(adapterSource).toContain("from '../node/visitor-context.js'");
  });
});
