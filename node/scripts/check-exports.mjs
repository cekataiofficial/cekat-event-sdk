#!/usr/bin/env node
/** Verifies published subpath targets and rejects Node-only symbols from browser artifacts. */
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageManifest from '../package.json' with { type: 'json' };
import { assertBrowserBoundary } from './check-browser-boundary.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const forbidden = [
  { pattern: /node:/, label: 'node:' },
  { pattern: /async_hooks/, label: 'async_hooks' },
  { pattern: /\bClient\b/, label: 'Client' },
  { pattern: /Authorization/, label: 'Authorization' },
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesUnder(resolve(directory, entry.name))
    : [resolve(directory, entry.name)]))).flat();
}
function exportTargets(exports) {
  const targets = [];
  for (const [subpath, entry] of Object.entries(exports)) {
    if (!subpath.startsWith('./') || typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`invalid export definition for ${subpath}`);
    for (const condition of ['types', 'import']) {
      const target = entry[condition];
      if (typeof target !== 'string' || !target.startsWith('./dist/')) throw new Error(`export ${subpath} is missing a dist ${condition} target`);
      targets.push([subpath, condition, target]);
    }
  }
  return targets;
}
export async function assertPackageExports({ root = projectRoot } = {}) {
  const exports = packageManifest.exports;
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) throw new Error('package exports must be an object');
  for (const [subpath, condition, target] of exportTargets(exports)) {
    try { await access(resolve(root, target)); } catch { throw new Error(`export ${subpath} ${condition} target does not exist: ${target}`); }
  }
  await assertBrowserBoundary({ projectRoot: root });
  const browserArtifactRoot = resolve(root, 'dist/browser');
  for (const file of await filesUnder(browserArtifactRoot)) {
    if (!/\.(?:js|mjs|cjs|d\.ts)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const entry of forbidden) if (entry.pattern.test(source)) throw new Error(`browser artifact ${relative(root, file)} contains forbidden ${entry.label}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertPackageExports().then(() => process.stdout.write('Package exports and browser artifact graph are valid.\n')).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
