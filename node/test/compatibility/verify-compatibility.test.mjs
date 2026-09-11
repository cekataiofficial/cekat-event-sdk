import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompatibility, renderCompatibilityMarkdown } from '../../scripts/verify-compatibility.mjs';

const retrievedAt = '2026-09-10T12:00:00.000Z';
const sources = {
  nodeSchedule: 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json',
  nodeIndex: 'https://nodejs.org/dist/index.json',
  npm: 'npm view <package> versions time engines dist-tags --json',
};

function metadata(versions, engines = {}) {
  return {
    versions,
    time: Object.fromEntries(versions.map((version) => [version, '2026-09-01T00:00:00.000Z'])),
    engines,
    'dist-tags': { latest: versions.at(-1) },
  };
}

function fixtures() {
  const nodeSchedule = {
    v20: { start: '2023-04-18', lts: '2023-10-24', maintenance: '2024-09-03', end: '2026-04-30' },
    v22: { start: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30' },
    v23: { start: '2024-10-16', end: '2025-06-01' },
    v24: { start: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30' },
  };
  const nodeIndex = [
    { version: 'v24.3.0', lts: 'Krypton', date: '2026-09-01' },
    { version: 'v22.18.0', lts: 'Jod', date: '2026-09-01' },
    { version: 'v20.19.0', lts: 'Iron', date: '2026-09-01' },
  ];
  const runtimeEngines = { '5.0.0': { node: '>=22' }, '5.1.0': { node: '>=22' }, '2.16.0': { node: '>=22' }, '2.16.1': { node: '>=22' }, '11.0.0': { node: '>=22' }, '11.1.0': { node: '>=22' }, '15.0.0': { node: '>=22' }, '15.1.0': { node: '>=22' }, '1.8.0': { node: '>=22' }, '1.9.0': { node: '>=22' } };
  const expressEngines = { ...runtimeEngines };
  const fastifyEngines = { ...runtimeEngines };
  return {
    nodeSchedule,
    nodeIndex,
    packages: {
      typescript: metadata(['5.8.3']),
      vitest: metadata(['3.2.4']),
      playwright: metadata(['1.54.0']),
      '@types/node': metadata(['22.15.0', '24.0.0']),
      express: metadata(['5.0.0', '5.1.0'], expressEngines),
      '@types/express': metadata(['5.0.0', '5.0.1']),
      fastify: metadata(['5.0.0', '5.1.0'], fastifyEngines),
      'fastify-plugin': metadata(['5.0.0', '5.1.0'], runtimeEngines),
      koa: metadata(['2.16.0', '2.16.1'], runtimeEngines),
      '@types/koa': metadata(['2.15.0', '2.15.1']),
      nestjs: metadata(['11.0.0', '11.1.0'], runtimeEngines),
      nextjs: metadata(['15.0.0', '15.1.0'], runtimeEngines),
      axios: metadata(['1.8.0', '1.9.0'], runtimeEngines),
    },
  };
}

test('rejects EOL Node lines, prereleases, floor-incompatible engines, and unresolved Next Node runtime', () => {
  const input = fixtures();
  input.nodeSchedule.v22.end = '2026-01-01';
  input.nodeSchedule.v24.end = '2026-01-01';
  input.nodeIndex[1].version = 'v22.19.0-rc.1';
  assert.throws(() => evaluateCompatibility(input, { now: retrievedAt }), /maintained even Node line/i);

  const prerelease = fixtures();
  prerelease.packages.express.versions.push('5.2.0-rc.1');
  prerelease.packages.express.time['5.2.0-rc.1'] = '2026-09-02T00:00:00.000Z';
  prerelease.packages.express.engines['5.2.0-rc.1'] = { node: '>=22' };
  assert.equal(evaluateCompatibility(prerelease, { now: retrievedAt }).versions.express, '5.1.0');

  const incompatible = fixtures();
  incompatible.packages.fastify.engines['5.1.0'] = { node: '<22' };
  assert.throws(() => evaluateCompatibility(incompatible, { now: retrievedAt }), /fastify.*Node floor/i);

  const unresolvedNext = fixtures();
  delete unresolvedNext.packages.nextjs.engines['15.1.0'];
  assert.throws(() => evaluateCompatibility(unresolvedNext, { now: retrievedAt }), /Next.*Node runtime/i);
});

test('renders dated official evidence with source URLs, exact versions, and support ranges', () => {
  const evidence = evaluateCompatibility(fixtures(), { now: retrievedAt, sources });
  const markdown = renderCompatibilityMarkdown(evidence);
  assert.match(markdown, /2026-09-10T12:00:00\.000Z/);
  assert.match(markdown, new RegExp(sources.nodeSchedule.replace(/[./]/g, '\\$&')));
  assert.match(markdown, new RegExp(sources.nodeIndex.replace(/[./]/g, '\\$&')));
  assert.match(markdown, /Express \| 5\.1\.0 \| \^5\.0\.0/);
  assert.match(markdown, /Node\.js \| v22\.18\.0 \| >=22\.0\.0 <26\.0\.0/);
  assert.match(markdown, /Next\.js.*15\.1\.0/);
});
