#!/usr/bin/env node
/**
 * Blocks dependency setup unless current official Node and npm metadata supports
 * the Node 22+ LTS policy. It deliberately records only metadata fetched here.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const NPM_SOURCE = 'npm view <package> versions time engines dist-tags --json';
const packageNames = {
  typescript: 'typescript', vitest: 'vitest', playwright: 'playwright',
  'types-node': '@types/node', express: 'express', 'types-express': '@types/express',
  fastify: 'fastify', 'fastify-plugin': 'fastify-plugin', koa: 'koa', 'types-koa': '@types/koa',
  nestjs: '@nestjs/common', nextjs: 'next', axios: 'axios',
};
const runtimeKeys = new Set(['express', 'fastify', 'fastify-plugin', 'koa', 'nestjs', 'nextjs', 'axios']);
const typeMatch = new Set(['types-node', 'types-express', 'types-koa']);

function fail(message) { throw new Error(`Compatibility verification failed: ${message}`); }
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.replace(/^v/, ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] } : undefined;
}
function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  return 0;
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
function engineFor(metadata, version) {
  const engines = metadata.engines;
  if (!engines || typeof engines !== 'object') return undefined;
  if (typeof engines.node === 'string') return engines.node;
  return engines[version]?.node;
}
/** Conservative semver range evaluator for official npm engines.node values. */
function permitsNodeFloor(range, floorMajor) {
  if (typeof range !== 'string' || !range.trim()) return false;
  const alternatives = range.split('||').map((part) => part.trim());
  return alternatives.some((alternative) => {
    if (/\b(?:x|X|\*)\b/.test(alternative)) return true;
    const comparators = alternative.match(/(?:>=|<=|>|<|=|~|\^)?\s*v?\d+(?:\.\d+)?(?:\.\d+)?/g);
    if (!comparators) return false;
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|=|~\s*|\^\s*)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator.trim());
      if (!match) return false;
      const operator = (match[1] || '=').trim(); const major = Number(match[2]);
      if (operator === '<') return floorMajor < major;
      if (operator === '<=') return floorMajor <= major;
      if (operator === '>') return floorMajor > major;
      if (operator === '>=') return floorMajor >= major;
      if (operator === '^' || operator === '~') return floorMajor >= major && floorMajor < major + 1;
      return floorMajor === major;
    });
  });
}
function supportRange(majors) { return `>=${Math.min(...majors)}.0.0 <${Math.max(...majors) + 2}.0.0`; }

export function evaluateCompatibility(input, { now = new Date().toISOString(), sources = {} } = {}) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) fail('retrieval timestamp is invalid');
  const maintained = Object.entries(input.nodeSchedule ?? {}).flatMap(([line, schedule]) => {
    const major = Number(line.replace(/^v/, ''));
    if (!Number.isInteger(major) || major < 22 || major % 2 || !schedule?.lts || new Date(schedule.end) <= date) return [];
    return [major];
  }).sort((a, b) => a - b);
  if (!maintained.length) fail('no maintained even Node line at or above Node 22 is present in official schedule metadata');
  const nodeVersions = {};
  for (const major of maintained) {
    const matching = (input.nodeIndex ?? []).map((entry) => entry.version).filter((version) => parseVersion(version)?.major === major && !isPrerelease(version));
    if (!matching.length) fail(`official Node index has no stable release for maintained Node ${major}`);
    nodeVersions[major] = latestStable(matching);
  }
  const floor = maintained[0];
  const versions = {};
  for (const [key, npmName] of Object.entries(packageNames)) {
    const metadata = input.packages?.[npmName] ?? input.packages?.[key];
    if (!metadata?.versions) fail(`official npm metadata is unavailable for ${npmName}`);
    const expectedMajor = key === 'types-node' ? floor : undefined;
    versions[key] = latestStable(metadata.versions, expectedMajor);
    if (key === 'nextjs' && !permitsNodeFloor(engineFor(metadata, versions[key]), floor)) {
      fail(`Next.js ${versions[key]} cannot be constrained to a supported Node runtime`);
    }
    const engine = engineFor(metadata, versions[key]);
    if (runtimeKeys.has(key) && engine !== undefined && !permitsNodeFloor(engine, floor)) {
      fail(`${npmName} ${versions[key]} engines.node does not include Node floor ${floor}`);
    }
  }
  return {
    retrievedAt: date.toISOString(), sources: { nodeSchedule: sources.nodeSchedule ?? NODE_SCHEDULE_URL, nodeIndex: sources.nodeIndex ?? NODE_INDEX_URL, npm: sources.npm ?? NPM_SOURCE },
    node: { floor, majors: maintained, versions: nodeVersions, range: supportRange(maintained) }, versions,
  };
}

export function renderCompatibilityMarkdown(evidence) {
  const rows = [
    ['Node.js', evidence.node.versions[evidence.node.floor], evidence.node.range],
    ['TypeScript', evidence.versions.typescript, `^${parseVersion(evidence.versions.typescript).major}.0.0`],
    ['Vitest', evidence.versions.vitest, `^${parseVersion(evidence.versions.vitest).major}.0.0`],
    ['Playwright', evidence.versions.playwright, `^${parseVersion(evidence.versions.playwright).major}.0.0`],
    ['@types/node', evidence.versions['types-node'], `^${evidence.node.floor}.0.0`],
    ['Express', evidence.versions.express, `^${parseVersion(evidence.versions.express).major}.0.0`],
    ['@types/express', evidence.versions['types-express'], `^${parseVersion(evidence.versions['types-express']).major}.0.0`],
    ['Fastify', evidence.versions.fastify, `^${parseVersion(evidence.versions.fastify).major}.0.0`],
    ['fastify-plugin', evidence.versions['fastify-plugin'], `^${parseVersion(evidence.versions['fastify-plugin']).major}.0.0`],
    ['Koa', evidence.versions.koa, `^${parseVersion(evidence.versions.koa).major}.0.0`],
    ['@types/koa', evidence.versions['types-koa'], `^${parseVersion(evidence.versions['types-koa']).major}.0.0`],
    ['NestJS', evidence.versions.nestjs, `^${parseVersion(evidence.versions.nestjs).major}.0.0`],
    ['Next.js (Node runtime)', evidence.versions.nextjs, `^${parseVersion(evidence.versions.nextjs).major}.0.0`],
    ['Axios', evidence.versions.axios, `^${parseVersion(evidence.versions.axios).major}.0.0`],
  ];
  return `# Node SDK compatibility evidence\n\nRetrieved: ${evidence.retrievedAt}\n\n## Official sources\n\n- Node release schedule: ${evidence.sources.nodeSchedule}\n- Node distribution index: ${evidence.sources.nodeIndex}\n- npm registry: \`${evidence.sources.npm}\`\n\nThe compatibility gate selected maintained even-numbered LTS lines ${evidence.node.majors.join(', ')}. The package engine floor is Node ${evidence.node.floor}; odd and EOL lines are not supported. Next.js is restricted to its Node runtime.\n\n| Component | Exact observed version | Selected support range |\n| --- | --- | --- |\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return response.json();
}
function npmView(name) {
  try { return JSON.parse(execFileSync('npm', ['view', name, 'versions', 'time', 'engines', 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })); }
  catch { fail(`official npm metadata is unavailable for ${name}`); }
}
async function collectOfficialMetadata() {
  const [nodeSchedule, nodeIndex] = await Promise.all([fetchJson(NODE_SCHEDULE_URL), fetchJson(NODE_INDEX_URL)]);
  const packages = Object.fromEntries(Object.values(packageNames).map((name) => [name, npmView(name)]));
  return { nodeSchedule, nodeIndex, packages };
}
async function main() {
  const args = process.argv.slice(2);
  const printIndex = args.indexOf('--print');
  if (args.some((arg, index) => !['--write', '--print'].includes(arg) && index !== printIndex + 1)) fail(`unknown argument ${args.find((arg, index) => !['--write', '--print'].includes(arg) && index !== printIndex + 1)}`);
  if (printIndex !== -1 && (!args[printIndex + 1] || !packageNames[args[printIndex + 1]])) fail('--print requires a known compatibility key');
  const evidence = evaluateCompatibility(await collectOfficialMetadata());
  if (args.includes('--write')) {
    const output = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/compatibility.md');
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, renderCompatibilityMarkdown(evidence));
  }
  if (printIndex !== -1) process.stdout.write(`${evidence.versions[args[printIndex + 1]]}\n`);
  else process.stdout.write(`Compatibility verified: Node ${evidence.node.range}; ${Object.entries(evidence.versions).map(([key, version]) => `${key} ${version}`).join(', ')}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
