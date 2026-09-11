#!/usr/bin/env node
/**
 * Records the official metadata needed to support this package's declared Node
 * engine floor. It intentionally makes no claim about framework runtime graphs.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const NPM_SOURCE = 'npm view <package> versions time engines dist-tags --json';
const packageNames = {
  typescript: 'typescript', vitest: 'vitest', playwright: 'playwright',
  'types-node': '@types/node', express: 'express', 'types-express': '@types/express',
  fastify: 'fastify', 'fastify-plugin': 'fastify-plugin', koa: 'koa', 'types-koa': '@types/koa',
  nestjs: '@nestjs/common', 'nestjs-core': '@nestjs/core',
  'nestjs-platform-express': '@nestjs/platform-express', 'nestjs-platform-fastify': '@nestjs/platform-fastify',
  nextjs: 'next', axios: 'axios',
};
const nodeEngineKeys = new Set([
  'express', 'fastify', 'fastify-plugin', 'koa', 'nestjs', 'nestjs-core',
  'nestjs-platform-express', 'nestjs-platform-fastify', 'nextjs', 'axios',
]);

function fail(message) { throw new Error(`Compatibility verification failed: ${message}`); }
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).replace(/^v/, ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] } : undefined;
}
function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  return 0;
}
function normalizedVersion(version) {
  const parsed = parseVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : undefined;
}
function isPrerelease(version) { return !parseVersion(version) || Boolean(parseVersion(version).prerelease); }
function latestStable(versions, requiredMajor) {
  const stable = versions.filter((version) => {
    const parsed = parseVersion(version);
    return parsed && !parsed.prerelease && (requiredMajor === undefined || parsed.major === requiredMajor);
  }).sort(compareVersions);
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
function compareParsed(left, right) {
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] - right[key];
  return 0;
}
function comparatorAccepts(version, operator, target) {
  const compared = compareParsed(version, target);
  switch (operator) {
    case '>': return compared > 0;
    case '>=': return compared >= 0;
    case '<': return compared < 0;
    case '<=': return compared <= 0;
    case '^': {
      const upper = target.major > 0 ? { major: target.major + 1, minor: 0, patch: 0 } : target.minor > 0 ? { major: 0, minor: target.minor + 1, patch: 0 } : { major: 0, minor: 0, patch: target.patch + 1 };
      return compared >= 0 && compareParsed(version, upper) < 0;
    }
    case '~': return compared >= 0 && version.major === target.major && version.minor === target.minor;
    default: return compared === 0;
  }
}
/** Evaluates the declared exact floor against standard npm engines semver ranges. */
export function permitsNodeVersion(range, version) {
  const candidate = parseVersion(version);
  if (!candidate || candidate.prerelease || typeof range !== 'string' || !range.trim()) return false;
  return range.split('||').some((alternative) => {
    const part = alternative.trim();
    if (!part) return false;
    const hyphen = /^(v?\d+(?:\.\d+){0,2})\s+-\s+(v?\d+(?:\.\d+){0,2})$/.exec(part);
    if (hyphen) return comparatorAccepts(candidate, '>=', parsePartialVersion(hyphen[1])) && comparatorAccepts(candidate, '<=', parsePartialVersion(hyphen[2]));
    const matches = [...part.matchAll(/(\^|~|>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+){0,2}|[xX*](?:\.[xX*]){0,2})/g)];
    if (!matches.length || matches.map((match) => match[0]).join('').replace(/\s/g, '') !== part.replace(/\s/g, '')) return false;
    return matches.every((match) => {
      const raw = match[2].replace(/^v/, '');
      if (/[xX*]/.test(raw)) {
        const fixed = raw.split('.').filter((segment) => !/[xX*]/.test(segment));
        return fixed.every((segment, index) => candidate[['major', 'minor', 'patch'][index]] === Number(segment));
      }
      return comparatorAccepts(candidate, match[1] || '=', parsePartialVersion(raw));
    });
  });
}
function parsePartialVersion(raw) {
  const pieces = raw.replace(/^v/, '').split('.').map(Number);
  return { major: pieces[0], minor: pieces[1] ?? 0, patch: pieces[2] ?? 0 };
}
function declaredFloor(range) {
  const match = /(?:^|\s|\|\|)>=\s*v?(\d+(?:\.\d+){0,2})/.exec(range);
  if (!match) fail(`declared package engines.node range ${range} has no explicit >= floor`);
  return normalizedVersion(match[1]);
}
function supportRange(majors) { return `>=${Math.min(...majors)}.0.0 <${Math.max(...majors) + 2}.0.0`; }
function isActiveLts(schedule, date) {
  const start = new Date(schedule?.start); const lts = new Date(schedule?.lts); const end = new Date(schedule?.end);
  return Boolean(schedule?.lts) && !Number.isNaN(start.valueOf()) && !Number.isNaN(lts.valueOf()) && !Number.isNaN(end.valueOf()) && start <= date && lts <= date && end > date;
}

export function evaluateCompatibility(input, { now = new Date().toISOString(), sources = {}, packageNodeRange = '>=22.0.0 <28.0.0' } = {}) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) fail('retrieval timestamp is invalid');
  const floorVersion = declaredFloor(packageNodeRange);
  const floorMajor = parseVersion(floorVersion).major;
  const maintained = Object.entries(input.nodeSchedule ?? {}).flatMap(([line, schedule]) => {
    const major = Number(line.replace(/^v/, ''));
    return Number.isInteger(major) && major >= floorMajor && major % 2 === 0 && isActiveLts(schedule, date) ? [major] : [];
  }).sort((a, b) => a - b);
  if (!maintained.length) fail('no active maintained even Node LTS line at or above the declared floor is present in official schedule metadata');
  const nodeVersions = {};
  for (const major of maintained) {
    const matching = (input.nodeIndex ?? []).map((entry) => entry.version).filter((version) => parseVersion(version)?.major === major && !isPrerelease(version));
    if (!matching.length) fail(`official Node index has no stable release for maintained Node ${major}`);
    nodeVersions[major] = latestStable(matching);
  }
  const versions = {};
  for (const key of Object.keys(packageNames)) {
    const metadata = metadataFor(input, key);
    const expectedMajor = key === 'types-node' ? floorMajor : undefined;
    versions[key] = latestStable(metadata.versions, expectedMajor);
    if (!metadata.time[versions[key]]) fail(`official npm metadata has no publication time for ${packageNames[key]} ${versions[key]}`);
    if (nodeEngineKeys.has(key)) {
      const engine = engineFor(metadata, versions[key]);
      // An absent engines field does not exclude the floor. A declared field must.
      if (engine !== undefined && !permitsNodeVersion(engine, floorVersion)) fail(`${packageNames[key]} ${versions[key]} engines.node does not include declared Node floor ${floorVersion}`);
      if (key === 'nextjs' && engine === undefined) fail(`Next.js ${versions[key]} has no engines.node metadata to establish Node engine compatibility`);
    }
  }
  for (const [typesKey, runtimeKey] of [['types-express', 'express'], ['types-koa', 'koa']]) {
    if (parseVersion(versions[typesKey]).major !== parseVersion(versions[runtimeKey]).major) fail(`${packageNames[typesKey]} must match ${packageNames[runtimeKey]} major ${parseVersion(versions[runtimeKey]).major}`);
  }
  const nestMajor = parseVersion(versions.nestjs).major;
  for (const key of ['nestjs-core', 'nestjs-platform-express', 'nestjs-platform-fastify']) {
    if (parseVersion(versions[key]).major !== nestMajor) fail(`${packageNames[key]} must match NestJS major ${nestMajor}`);
  }
  return {
    retrievedAt: date.toISOString(), packageNodeRange, nodeFloor: floorVersion,
    sources: { nodeSchedule: sources.nodeSchedule ?? NODE_SCHEDULE_URL, nodeIndex: sources.nodeIndex ?? NODE_INDEX_URL, npm: sources.npm ?? NPM_SOURCE },
    node: { floor: floorMajor, majors: maintained, versions: nodeVersions, range: supportRange(maintained) }, versions,
  };
}

export function renderCompatibilityMarkdown(evidence) {
  const labels = {
    typescript: 'TypeScript', vitest: 'Vitest', playwright: 'Playwright', 'types-node': '@types/node', express: 'Express', 'types-express': '@types/express', fastify: 'Fastify', 'fastify-plugin': 'fastify-plugin', koa: 'Koa', 'types-koa': '@types/koa', nestjs: '@nestjs/common', 'nestjs-core': '@nestjs/core', 'nestjs-platform-express': '@nestjs/platform-express', 'nestjs-platform-fastify': '@nestjs/platform-fastify', nextjs: 'Next.js (Node engine compatibility)', axios: 'Axios',
  };
  const rows = [['Node.js', evidence.node.versions[evidence.node.floor], evidence.node.range], ...Object.entries(evidence.versions).map(([key, version]) => [labels[key], version, `^${parseVersion(version).major}.0.0`])];
  return `# Node SDK compatibility evidence\n\nRetrieved: ${evidence.retrievedAt}\n\n## Official sources\n\n- Node release schedule: ${evidence.sources.nodeSchedule}\n- Node distribution index: ${evidence.sources.nodeIndex}\n- npm registry: \`${evidence.sources.npm}\`\n\nThe compatibility gate selected active even-numbered Node LTS lines ${evidence.node.majors.join(', ')}: each line has started, reached its LTS date, and is not EOL. The declared package engine floor is Node ${evidence.nodeFloor} (${evidence.packageNodeRange}); odd and EOL lines are not supported. npm metadata establishes only that Next.js accepts this Node version; it does not establish a Next.js runtime boundary. A separate package-graph guard will reject Node-only imports from browser/Edge-reachable source paths when a Next adapter is added.\n\n| Component | Exact observed version | Selected support range |\n| --- | --- | --- |\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
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
      // npm's field selector omits `engines` for packages that have no engines;
      // an empty object is valid metadata and must be evaluated as such.
      const output = execFileSync('npm', ['view', `${name}@${version}`, 'engines', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
      return { engines: output ? JSON.parse(output) : {} };
    }
    return JSON.parse(execFileSync('npm', ['view', name, 'versions', 'time', 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  } catch { fail(`official npm metadata is unavailable for ${name}`); }
}
export async function collectOfficialMetadata({ fetchJson = fetchJsonFromUrl, npmView = npmViewFromRegistry } = {}) {
  let nodeSchedule; let nodeIndex;
  try { [nodeSchedule, nodeIndex] = await Promise.all([fetchJson(NODE_SCHEDULE_URL), fetchJson(NODE_INDEX_URL)]); }
  catch (error) { if (/Compatibility verification failed/.test(error.message)) throw error; fail('official Node metadata is unavailable'); }
  const packages = {};
  for (const [key, name] of Object.entries(packageNames)) {
    const metadata = npmView(name);
    if (!metadata?.versions) fail(`official npm metadata is unavailable or malformed for ${name}`);
    const version = latestStable(metadata.versions, key === 'types-node' ? 22 : undefined);
    if (nodeEngineKeys.has(key)) {
      const perVersion = npmView(name, version);
      metadata.engines = { [version]: perVersion.engines };
    }
    // Tests may use a metadata fixture keyed by the package alias; production
    // uses npm names, so retain both without changing the collection contract.
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
async function readDeclaredNodeRange() {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  return JSON.parse(await readFile(packagePath, 'utf8')).engines?.node;
}
export async function runCli(args, {
  collect = collectOfficialMetadata, now, packageNodeRange, mkdir: makeDirectory = mkdir, writeFile: write = writeFile,
  output = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/compatibility.md'), stdout = (line) => process.stdout.write(line),
} = {}) {
  const { write: shouldWrite, print } = parseArgs(args);
  const range = packageNodeRange ?? await readDeclaredNodeRange();
  const evidence = evaluateCompatibility(await collect(), { now, packageNodeRange: range });
  if (shouldWrite) { await makeDirectory(dirname(output), { recursive: true }); await write(output, renderCompatibilityMarkdown(evidence)); }
  if (print !== undefined) stdout(`${evidence.versions[print]}\n`);
  else stdout(`Compatibility verified: Node ${evidence.node.range}; ${Object.entries(evidence.versions).map(([key, version]) => `${key} ${version}`).join(', ')}\n`);
  return evidence;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
