import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectOfficialMetadata,
  evaluateCompatibility,
  renderCompatibilityMarkdown,
  runCli,
} from '../../scripts/verify-compatibility.mjs';

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
    v22: { start: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30' },
    v24: { start: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30' },
    v26: { start: '2026-05-20', lts: '2026-10-28', maintenance: '2027-10-20', end: '2029-04-30' },
  };
  const nodeIndex = [
    { version: 'v24.3.0', lts: 'Krypton', date: '2026-09-01' },
    { version: 'v22.18.0', lts: 'Jod', date: '2026-09-01' },
    { version: 'v26.0.0', lts: false, date: '2026-05-20' },
  ];
  const engines = (versions) => Object.fromEntries(versions.map((version) => [version, { node: '>=22.0.0' }]));
  const nestVersions = ['12.0.0', '12.1.0'];
  return {
    nodeSchedule,
    nodeIndex,
    packages: {
      typescript: metadata(['5.8.3']),
      vitest: metadata(['3.2.4']),
      playwright: metadata(['1.54.0']),
      '@types/node': metadata(['22.15.0', '24.0.0']),
      express: metadata(['5.0.0', '5.1.0'], engines(['5.0.0', '5.1.0'])),
      '@types/express': metadata(['5.0.0', '5.0.1']),
      fastify: metadata(['5.0.0', '5.1.0'], engines(['5.0.0', '5.1.0'])),
      'fastify-plugin': metadata(['6.0.0'], engines(['6.0.0'])),
      koa: metadata(['3.0.0', '3.1.0'], engines(['3.0.0', '3.1.0'])),
      '@types/koa': metadata(['3.0.0', '3.0.1']),
      '@nestjs/common': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/core': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/platform-express': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/platform-fastify': metadata(nestVersions, engines(nestVersions)),
      next: metadata(['15.0.0', '15.1.0'], engines(['15.0.0', '15.1.0'])),
      axios: metadata(['1.8.0', '1.9.0'], engines(['1.8.0', '1.9.0'])),
    },
  };
}

test('selects only started LTS lines and validates exact engine floors, declarations, and Nest companions', () => {
  const evidence = evaluateCompatibility(fixtures(), { now: retrievedAt, sources, packageNodeRange: '>=22.0.0 <28.0.0' });
  assert.deepEqual(evidence.node.majors, [22, 24]);
  assert.equal(evidence.versions.nestjs, '12.1.0');
  assert.equal(evidence.versions['nestjs-core'], '12.1.0');

  const futureLts = fixtures();
  futureLts.nodeSchedule.v22.end = '2026-01-01';
  futureLts.nodeSchedule.v24.end = '2026-01-01';
  assert.throws(() => evaluateCompatibility(futureLts, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /maintained.*LTS/i);

  const incompatibleExactFloor = fixtures();
  incompatibleExactFloor.packages.fastify.engines['5.1.0'] = { node: '>=22.12.0' };
  assert.throws(() => evaluateCompatibility(incompatibleExactFloor, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /fastify.*22\.0\.0/i);

  const declarationMismatch = fixtures();
  declarationMismatch.packages['@types/express'].versions = ['4.99.0'];
  declarationMismatch.packages['@types/express'].time = { '4.99.0': '2026-09-01T00:00:00.000Z' };
  assert.throws(() => evaluateCompatibility(declarationMismatch, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /@types\/express.*Express major/i);

  const nestMismatch = fixtures();
  nestMismatch.packages['@nestjs/core'].versions = ['13.0.0'];
  nestMismatch.packages['@nestjs/core'].engines = { '13.0.0': { node: '>=22.0.0' } };
  nestMismatch.packages['@nestjs/core'].time = { '13.0.0': '2026-09-01T00:00:00.000Z' };
  assert.throws(() => evaluateCompatibility(nestMismatch, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /@nestjs\/core.*NestJS major/i);
});

test('renders evidence that limits Next.js conclusions to Node engine compatibility', () => {
  const markdown = renderCompatibilityMarkdown(evaluateCompatibility(fixtures(), {
    now: retrievedAt,
    sources,
    packageNodeRange: '>=22.0.0 <28.0.0',
  }));
  assert.match(markdown, /2026-09-10T12:00:00\.000Z/);
  assert.match(markdown, new RegExp(sources.nodeSchedule.replace(/[./]/g, '\\$&')));
  assert.match(markdown, /Node\.js \| v22\.18\.0 \| >=22\.0\.0 <26\.0\.0/);
  assert.match(markdown, /Next\.js \(Node engine compatibility\)/);
  assert.doesNotMatch(markdown, /restricted to its Node runtime/i);
  assert.match(markdown, /does not establish a Next\.js runtime boundary/i);
});

test('collects official sources and tests CLI write plus source failures through injected dependencies', async () => {
  const calls = [];
  const collected = await collectOfficialMetadata({
    fetchJson: async (url) => {
      calls.push(url);
      return url === sources.nodeSchedule ? fixtures().nodeSchedule : fixtures().nodeIndex;
    },
    npmView: (name) => fixtures().packages[name],
  });
  assert.equal(calls.length, 2);
  assert.equal(collected.packages.fastify, collected.packages.fastify);

  const writes = [];
  const stdout = [];
  await runCli(['--write', '--print', 'nestjs-core'], {
    collect: async () => fixtures(),
    now: retrievedAt,
    packageNodeRange: '>=22.0.0 <28.0.0',
    mkdir: async () => {},
    writeFile: async (path, content) => writes.push({ path, content }),
    output: '/tmp/compatibility.md',
    stdout: (line) => stdout.push(line),
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /@nestjs\/core/);
  assert.deepEqual(stdout, ['12.1.0\n']);

  await assert.rejects(
    () => collectOfficialMetadata({ fetchJson: async () => { throw new Error('network unavailable'); }, npmView: () => ({}) }),
    /official Node metadata is unavailable/i,
  );
  await assert.rejects(
    () => runCli([], { collect: async () => { throw new Error('official npm metadata is unavailable for next'); } }),
    /official npm metadata is unavailable/i,
  );
});
