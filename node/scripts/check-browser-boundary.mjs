#!/usr/bin/env node
/** Reject node: built-ins anywhere reachable from browser or Next Edge entrypoints. */
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

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
function scriptKindFor(file) {
  switch (extname(file)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}
function stringValue(node) { return ts.isStringLiteralLike(node) ? node.text : undefined; }
function unparenthesized(expression) {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}
function importsIn(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  if (sourceFile.parseDiagnostics.length) throw new Error(`Unable to parse browser/Edge source ${file}: ${ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, ' ')}`);

  const specifiers = [];
  const addString = (node) => {
    const specifier = node && stringValue(node);
    if (specifier !== undefined) specifiers.push(specifier);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addString(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addString(node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      const callee = unparenthesized(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) addString(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
/**
 * Traverses local imports from browser exports and actual Next Edge entrypoints.
 * TypeScript's parser rejects malformed source before AST traversal identifies
 * static imports, re-exports, external import-equals declarations, literal
 * dynamic imports, and literal require calls. Literal specifiers include quoted
 * strings and no-substitution template literals.
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
