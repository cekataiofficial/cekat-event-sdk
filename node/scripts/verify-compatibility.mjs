#!/usr/bin/env node
/**
 * Records only official compatibility evidence for the package's declared Node
 * engine floor. Semver range interpretation is delegated to npm's maintained
 * `semver` implementation rather than reproduced here.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, minVersion, parse, prerelease, satisfies, validRange } from 'semver';

const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const NPM_SOURCE = 'npm view <package> versions time engines dist-tags --json; npm view <package>@<version> engines --json';
const TYPESCRIPT_COMPILER_API_VERSION = '5.9.3';
const packageNames = {
  typescript: 'typescript', vitest: 'vitest', playwright: 'playwright', semver: 'semver',
  'types-node': '@types/node', express: 'express', 'types-express': '@types/express',
  fastify: 'fastify', koa: 'koa', 'types-koa': '@types/koa',
  nestjs: '@nestjs/common', 'nestjs-core': '@nestjs/core',
  'nestjs-platform-express': '@nestjs/platform-express', 'nestjs-platform-fastify': '@nestjs/platform-fastify',
  nextjs: 'next', axios: 'axios',
};
// Tooling is recorded and locked but does not define this SDK's consumer runtime
// support. TypeScript is included because the boundary guard executes its parser.
// Every runtime, declaration, and plugin package does.
const runtimeEngineKeys = new Set([
  'typescript', 'types-node', 'express', 'types-express', 'fastify', 'koa', 'types-koa',
  'nestjs', 'nestjs-core', 'nestjs-platform-express', 'nestjs-platform-fastify', 'nextjs', 'axios',
]);

function fail(message) { throw new Error(`Compatibility verification failed: ${message}`); }
function parseVersion(version) { return parse(String(version).replace(/^v/, '')); }
function normalizedVersion(version) {
  const parsed = parseVersion(version);
  return parsed ? parsed.version : undefined;
}
function isPrerelease(version) { return !parseVersion(version) || Boolean(prerelease(String(version).replace(/^v/, ''))); }
function latestStable(versions, requiredMajor) {
  const stable = versions.filter((version) => {
    const parsed = parseVersion(version);
    return parsed && !parsed.prerelease.length && (requiredMajor === undefined || parsed.major === requiredMajor);
  }).sort((left, right) => compare(String(left).replace(/^v/, ''), String(right).replace(/^v/, '')));
  if (!stable.length) fail(`no stable${requiredMajor === undefined ? '' : ` major ${requiredMajor}`} package version is available`);
  return stable.at(-1);
}
function metadataFor(input, key) {
  const name = packageNames[key];
  const metadata = input.packages?.[name] ?? input.packages?.[key];
  if (!metadata || !Array.isArray(metadata.versions) || !metadata.versions.length || !metadata.time || typeof metadata.time !== 'object' || !metadata['dist-tags'] || typeof metadata['dist-tags'] !== 'object') {
    fail(`official npm metadata is unavailable or malformed for ${name}`);
  }
  return metadata;
}
function engineFor(metadata, version) {
  const engines = metadata.engines;
  if (!engines || typeof engines !== 'object') return undefined;
  return typeof engines.node === 'string' ? engines.node : engines[version]?.node;
}
/** Evaluates npm engines syntax with the maintained npm semver implementation. */
export function permitsNodeVersion(range, version) {
  const candidate = normalizedVersion(version);
  return Boolean(candidate && !isPrerelease(candidate) && typeof range === 'string' && validRange(range) && satisfies(candidate, range));
}
function declaredFloor(range) {
  if (typeof range !== 'string' || !validRange(range)) fail(`declared package engines.node range ${range} is not valid npm semver`);
  const floor = minVersion(range);
  if (!floor || floor.prerelease.length) fail(`declared package engines.node range ${range} has no stable floor`);
  return floor.version;
}
function supportRange(majors) {
  const ranges = [];
  for (const major of majors) {
    const previous = ranges.at(-1);
    if (previous && previous.lastMajor === major - 2) previous.lastMajor = major;
    else ranges.push({ firstMajor: major, lastMajor: major });
  }
  return ranges.map(({ firstMajor, lastMajor }) => `>=${firstMajor}.0.0 <${lastMajor + 2}.0.0`).join(' || ');
}
function isActiveLts(schedule, date) {
  const start = new Date(schedule?.start); const lts = new Date(schedule?.lts); const end = new Date(schedule?.end);
  return Boolean(schedule?.lts) && !Number.isNaN(start.valueOf()) && !Number.isNaN(lts.valueOf()) && !Number.isNaN(end.valueOf()) && start <= date && lts <= date && end > date;
}
function packageSupportsVersion(metadata, selectedVersion, nodeVersion) {
  const engine = engineFor(metadata, selectedVersion);
  return engine === undefined || permitsNodeVersion(engine, nodeVersion);
}

export function evaluateCompatibility(input, { now = new Date().toISOString(), sources = {}, packageNodeRange = '>=22.12.0 <28.0.0' } = {}) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) fail('retrieval timestamp is invalid');
  const floorVersion = declaredFloor(packageNodeRange);
  const floorMajor = parseVersion(floorVersion).major;
  const candidates = Object.entries(input.nodeSchedule ?? {}).flatMap(([line, schedule]) => {
    const major = Number(line.replace(/^v/, ''));
    return Number.isInteger(major) && major >= floorMajor && major % 2 === 0 && isActiveLts(schedule, date) ? [major] : [];
  }).sort((a, b) => a - b);
  if (!candidates.length) fail('no active maintained even Node LTS line at or above the declared floor is present in official schedule metadata');

  const nodeVersions = {};
  for (const major of candidates) {
    const matching = (input.nodeIndex ?? []).map((entry) => entry.version).filter((version) => parseVersion(version)?.major === major && !isPrerelease(version));
    if (!matching.length) fail(`official Node index has no stable release for maintained Node ${major}`);
    nodeVersions[major] = latestStable(matching);
  }

  const versions = {};
  const metadata = {};
  for (const key of Object.keys(packageNames)) {
    metadata[key] = metadataFor(input, key);
    const expectedMajor = key === 'types-node' ? floorMajor : undefined;
    versions[key] = key === 'typescript'
      ? TYPESCRIPT_COMPILER_API_VERSION
      : latestStable(metadata[key].versions, expectedMajor);
    if (key === 'typescript' && !metadata[key].versions.includes(versions[key])) fail(`official npm metadata does not include required TypeScript compiler API version ${versions[key]}`);
    if (!metadata[key].time[versions[key]]) fail(`official npm metadata has no publication time for ${packageNames[key]} ${versions[key]}`);
    const engine = engineFor(metadata[key], versions[key]);
    if (key === 'nextjs' && engine === undefined) fail(`Next.js ${versions[key]} has no engines.node metadata to establish Node engine compatibility`);
    if (runtimeEngineKeys.has(key) && engine !== undefined && !permitsNodeVersion(engine, floorVersion)) fail(`${packageNames[key]} ${versions[key]} engines.node does not include declared Node floor ${floorVersion}`);
  }

  for (const [typesKey, runtimeKey] of [['types-express', 'express'], ['types-koa', 'koa']]) {
    if (parseVersion(versions[typesKey]).major !== parseVersion(versions[runtimeKey]).major) fail(`${packageNames[typesKey]} must match ${packageNames[runtimeKey]} major ${parseVersion(versions[runtimeKey]).major}`);
  }
  const nestMajor = parseVersion(versions.nestjs).major;
  for (const key of ['nestjs-core', 'nestjs-platform-express', 'nestjs-platform-fastify']) {
    if (parseVersion(versions[key]).major !== nestMajor) fail(`${packageNames[key]} must match NestJS major ${nestMajor}`);
  }

  // A line is reported only if every selected runtime, declaration, plugin, and
  // tooling package with a declared Node engine accepts the exact stable release.
  const maintained = candidates.filter((major) => [...runtimeEngineKeys].every((key) => packageSupportsVersion(metadata[key], versions[key], nodeVersions[major])));
  if (!maintained.length) fail('no active maintained Node LTS line is supported by every selected package engine');
  return {
    retrievedAt: date.toISOString(), packageNodeRange, nodeFloor: floorVersion,
    sources: { nodeSchedule: sources.nodeSchedule ?? NODE_SCHEDULE_URL, nodeIndex: sources.nodeIndex ?? NODE_INDEX_URL, npm: sources.npm ?? NPM_SOURCE },
    node: { floor: floorMajor, majors: maintained, versions: Object.fromEntries(maintained.map((major) => [major, nodeVersions[major]])), range: supportRange(maintained) }, versions,
  };
}

export function renderCompatibilityMarkdown(evidence, peerDependencies = {}) {
  const labels = {
    typescript: 'TypeScript', vitest: 'Vitest', playwright: 'Playwright', semver: 'SemVer (npm maintained range evaluator)',
    'types-node': '@types/node', express: 'Express', 'types-express': '@types/express', fastify: 'Fastify', koa: 'Koa', 'types-koa': '@types/koa', nestjs: '@nestjs/common', 'nestjs-core': '@nestjs/core', 'nestjs-platform-express': '@nestjs/platform-express', 'nestjs-platform-fastify': '@nestjs/platform-fastify', nextjs: 'Next.js (Node engine compatibility)', axios: 'Axios',
  };
  const rows = [['Node.js', evidence.node.versions[evidence.node.floor], evidence.node.range], ...Object.entries(evidence.versions).map(([key, version]) => [labels[key], version, `^${parseVersion(version).major}.0.0`])];
  return `# Node SDK compatibility evidence\n\nRetrieved: ${evidence.retrievedAt}\n\n## Official sources\n\n- Node release schedule: ${evidence.sources.nodeSchedule}\n- Node distribution index: ${evidence.sources.nodeIndex}\n- npm registry: \`${evidence.sources.npm}\`\n\nThe compatibility gate selected active even-numbered Node LTS lines ${evidence.node.majors.join(', ')}: each line has started, reached its LTS date, is not EOL, and is accepted by every selected runtime, declaration, and plugin package engine. The declared package engine floor is Node ${evidence.nodeFloor} (${evidence.packageNodeRange}); odd, EOL, and package-engine-incompatible lines are not supported. TypeScript is deliberately pinned to the exact compatible version ${TYPESCRIPT_COMPILER_API_VERSION} because the browser/Edge boundary guard uses its supported createSourceFile compiler API for fail-closed AST parsing. npm metadata establishes only that Next.js accepts this Node version; it does not establish a Next.js runtime boundary. A separate package-graph guard rejects Node-only imports from browser and present Next Edge entrypoints.\n\n| Component | Exact observed version | Selected support range |\n| --- | --- | --- |\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n${renderPeerRanges(peerDependencies)}`;
}

function renderPeerRanges(peerDependencies) {
  const entries = Object.entries(peerDependencies).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return '';
  return `\n## Declared optional peer ranges\n\nAdapters import framework packages only for types, so each declared peer range covers the observed current major above plus older majors that share the adapter's middleware contract. The current majors are exercised by the integration suite; older majors are accepted by the same adapter API and must be exercised before release.\n\n| Peer package | Declared range |\n| --- | --- |\n${entries.map(([name, range]) => `| ${name} | ${String(range).replaceAll('|', '\\|')} |`).join('\n')}\n`;
}

async function fetchJsonFromUrl(url) {
  let response;
  try { response = await fetch(url); } catch { fail(`official Node metadata is unavailable from ${url}`); }
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  try { return await response.json(); } catch { fail(`official Node metadata is malformed from ${url}`); }
}
function npmViewFromRegistry(name, version) {
  try {
    if (version) {
      const output = execFileSync('npm', ['view', `${name}@${version}`, 'engines', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
      return { engines: output ? JSON.parse(output) : {} };
    }
    return JSON.parse(execFileSync('npm', ['view', name, 'versions', 'time', 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  } catch { fail(`official npm metadata is unavailable for ${name}`); }
}
function npmMetadata(name, npmView) {
  try {
    const metadata = npmView(name);
    if (!metadata || !Array.isArray(metadata.versions) || !metadata.time || typeof metadata.time !== 'object' || !metadata['dist-tags'] || typeof metadata['dist-tags'] !== 'object') fail(`official npm metadata is unavailable or malformed for ${name}`);
    return metadata;
  } catch (error) {
    if (/Compatibility verification failed/.test(error.message)) throw error;
    fail(`official npm metadata is unavailable for ${name}`);
  }
}
export async function collectOfficialMetadata({ fetchJson = fetchJsonFromUrl, npmView = npmViewFromRegistry } = {}) {
  let nodeSchedule; let nodeIndex;
  try { [nodeSchedule, nodeIndex] = await Promise.all([fetchJson(NODE_SCHEDULE_URL), fetchJson(NODE_INDEX_URL)]); }
  catch (error) { if (/Compatibility verification failed/.test(error.message)) throw error; fail('official Node metadata is unavailable'); }
  const packages = {};
  for (const [key, name] of Object.entries(packageNames)) {
    const metadata = npmMetadata(name, npmView);
    const version = key === 'typescript'
      ? TYPESCRIPT_COMPILER_API_VERSION
      : latestStable(metadata.versions, key === 'types-node' ? 22 : undefined);
    if (key === 'typescript' && !metadata.versions.includes(version)) fail(`official npm metadata does not include required TypeScript compiler API version ${version}`);
    try {
      const selected = npmView(name, version);
      if (!selected || !selected.engines || typeof selected.engines !== 'object') fail(`official npm metadata is unavailable or malformed for ${name}@${version}`);
      metadata.engines = { [version]: selected.engines };
    } catch (error) {
      if (/Compatibility verification failed/.test(error.message)) throw error;
      fail(`official npm metadata is unavailable for ${name}@${version}`);
    }
    packages[name] = metadata;
    packages[key] = metadata;
  }
  return { nodeSchedule, nodeIndex, packages };
}
function parseArgs(args) {
  let write = false; let print;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--write') write = true;
    else if (args[index] === '--print') { print = args[index + 1]; index += 1; }
    else fail(`unknown argument ${args[index]}`);
  }
  if (print !== undefined && !packageNames[print]) fail('--print requires a known compatibility key');
  return { write, print };
}
async function readPackageManifest() {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  return JSON.parse(await readFile(packagePath, 'utf8'));
}
export async function runCli(args, {
  collect = collectOfficialMetadata, now, packageNodeRange, mkdir: makeDirectory = mkdir, writeFile: write = writeFile,
  output = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/compatibility.md'), stdout = (line) => process.stdout.write(line),
} = {}) {
  const { write: shouldWrite, print } = parseArgs(args);
  const manifest = await readPackageManifest();
  const range = packageNodeRange ?? manifest.engines?.node;
  const evidence = evaluateCompatibility(await collect(), { now, packageNodeRange: range });
  if (shouldWrite) { await makeDirectory(dirname(output), { recursive: true }); await write(output, renderCompatibilityMarkdown(evidence, manifest.peerDependencies)); }
  if (print !== undefined) stdout(`${evidence.versions[print]}\n`);
  else stdout(`Compatibility verified: Node ${evidence.node.range}; ${Object.entries(evidence.versions).map(([key, version]) => `${key} ${version}`).join(', ')}\n`);
  return evidence;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
