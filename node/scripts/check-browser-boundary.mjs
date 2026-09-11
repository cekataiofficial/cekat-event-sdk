#!/usr/bin/env node
/** Reject node: built-ins anywhere reachable from browser or Next Edge entrypoints. */
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const importPattern = /(?:import\s*(?:[^'"()]*?\s*from\s*)?|export\s+(?:[^'"]*?\s*from\s*)?|import\s*\()\s*['"]([^'"]+)['"]/g;

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesUnder(resolve(directory, entry.name))
    : sourceExtensions.includes(extname(entry.name)) ? [resolve(directory, entry.name)] : []))).flat();
}
async function existingFilesUnder(directory) {
  try { return await filesUnder(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function resolveLocalImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const candidate = resolve(dirname(from), specifier);
  const extension = extname(candidate);
  const base = sourceExtensions.includes(extension) ? candidate.slice(0, -extension.length) : candidate;
  const candidates = sourceExtensions.map((sourceExtension) => `${base}${sourceExtension}`)
    .concat(sourceExtensions.map((sourceExtension) => resolve(candidate, `index${sourceExtension}`)));
  if (sourceExtensions.includes(extension)) candidates.unshift(candidate);
  for (const file of candidates) {
    try { await access(file); return file; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return undefined;
}
function importsIn(source) {
  return [...source.matchAll(importPattern)].map((match) => match[1]);
}
/**
 * Traverses local imports from browser exports and actual Next Edge entrypoints.
 * Nonrelative specifiers are package boundaries; only a reachable local node:
 * builtin is a browser/Edge leak.
 */
export async function assertBrowserBoundary({ projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url))) } = {}) {
  const sourceRoot = resolve(projectRoot, 'src');
  const entrypoints = [
    ...await existingFilesUnder(resolve(sourceRoot, 'browser')),
    ...await existingFilesUnder(resolve(sourceRoot, 'integrations/nextjs/edge')),
  ];
  const pending = [...entrypoints];
  const visited = new Set();
  const violations = [];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    for (const specifier of importsIn(source)) {
      if (specifier.startsWith('node:')) violations.push(relative(projectRoot, file));
      else {
        const imported = await resolveLocalImport(file, specifier);
        if (imported) pending.push(imported);
      }
    }
  }
  if (violations.length) throw new Error(`Browser/Edge package graph must not import node: modules: ${[...new Set(violations)].join(', ')}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) assertBrowserBoundary().then(() => process.stdout.write('Browser/Edge package graph contains no node: imports.\n')).catch((error) => { console.error(error.message); process.exitCode = 1; });
