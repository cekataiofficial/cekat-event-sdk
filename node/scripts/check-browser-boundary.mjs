#!/usr/bin/env node
/** Reject node: built-ins anywhere reachable from browser or Next Edge entrypoints. */
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanner } from 'typescript/unstable/ast/scanner';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const endOfFileToken = 1;
const stringLiteralToken = 10;

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
function tokensIn(source, file) {
  const scanner = createScanner(true, 0, source);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== endOfFileToken; kind = scanner.scan()) {
    if (scanner.isUnterminated()) throw new Error(`Unable to parse browser/Edge source ${file}: unterminated token`);
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
  return tokens;
}
function importsIn(source, file) {
  const tokens = tokensIn(source, file);
  const specifiers = [];
  const delimiters = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  const nesting = [];
  for (const token of tokens) {
    if (delimiters.has(token.text)) nesting.push(token.text);
    else if ([...delimiters.values()].includes(token.text)) {
      if (delimiters.get(nesting.pop()) !== token.text) throw new Error(`Unable to parse browser/Edge source ${file}: unmatched delimiter`);
    }
  }
  if (nesting.length) throw new Error(`Unable to parse browser/Edge source ${file}: unmatched delimiter`);

  const stringAt = (index) => tokens[index]?.kind === stringLiteralToken ? tokens[index].value : undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.text === 'import') {
      const first = tokens[index + 1];
      if (first?.text === '(') {
        const specifier = stringAt(index + 2);
        if (specifier) specifiers.push(specifier);
        continue;
      }
      const direct = stringAt(index + 1);
      if (direct) {
        specifiers.push(direct);
        continue;
      }
      let foundFrom = false;
      for (let cursor = index + 1; cursor < tokens.length && ![';', 'import', 'export'].includes(tokens[cursor].text); cursor += 1) {
        if (tokens[cursor].text === 'from') foundFrom = true;
        else if (foundFrom) {
          const specifier = stringAt(cursor);
          if (specifier) specifiers.push(specifier);
          break;
        }
      }
    } else if (token.text === 'export') {
      let foundFrom = false;
      for (let cursor = index + 1; cursor < tokens.length && ![';', 'import', 'export'].includes(tokens[cursor].text); cursor += 1) {
        if (tokens[cursor].text === 'from') foundFrom = true;
        else if (foundFrom) {
          const specifier = stringAt(cursor);
          if (specifier) specifiers.push(specifier);
          break;
        }
      }
    } else if (token.text === 'require' && tokens[index + 1]?.text === '(') {
      const specifier = stringAt(index + 2);
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}
/**
 * Traverses local imports from browser exports and actual Next Edge entrypoints.
 * The TypeScript compiler lexer identifies static imports, re-exports, literal
 * dynamic imports, and literal require calls without regex syntax gaps.
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
    for (const specifier of importsIn(source, relative(projectRoot, file))) {
      if (specifier.startsWith('node:')) violations.push(relative(projectRoot, file));
      else if (specifier.startsWith('.')) {
        const imported = await resolveLocalImport(file, specifier);
        if (!imported) throw new Error(`Unable to resolve local browser/Edge import ${specifier} from ${relative(projectRoot, file)}`);
        pending.push(imported);
      }
    }
  }
  if (violations.length) throw new Error(`Browser/Edge package graph must not import node: modules: ${[...new Set(violations)].join(', ')}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) assertBrowserBoundary().then(() => process.stdout.write('Browser/Edge package graph contains no node: imports.\n')).catch((error) => { console.error(error.message); process.exitCode = 1; });
