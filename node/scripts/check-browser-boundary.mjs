#!/usr/bin/env node
/** Reject Node built-ins in browser/Edge-reachable sources (including future adapters). */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesUnder(resolve(directory, entry.name))
    : entry.name.endsWith('.ts') ? [resolve(directory, entry.name)] : []))).flat();
}
export async function assertBrowserBoundary({ root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src/browser') } = {}) {
  let files = [];
  try { files = await filesUnder(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const violations = [];
  for (const file of files) if (/from\s*['"]node:|import\s*\(?\s*['"]node:/.test(await readFile(file, 'utf8'))) violations.push(relative(process.cwd(), file));
  if (violations.length) throw new Error(`Browser package graph must not import node: modules: ${violations.join(', ')}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) assertBrowserBoundary().then(() => process.stdout.write('Browser package graph contains no node: imports.\n')).catch((error) => { console.error(error.message); process.exitCode = 1; });
