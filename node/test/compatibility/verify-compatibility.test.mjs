import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectOfficialMetadata,
  evaluateCompatibility,
  permitsNodeVersion,
  renderCompatibilityMarkdown,
  runCli,
} from '../../scripts/verify-compatibility.mjs';
import { assertBrowserBoundary } from '../../scripts/check-browser-boundary.mjs';

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
  const engines = (versions, range = '>=22.0.0') => Object.fromEntries(versions.map((version) => [version, { node: range }]));
  const nestVersions = ['12.0.0', '12.1.0'];
  return {
    nodeSchedule,
    nodeIndex,
    packages: {
      typescript: metadata(['5.8.3', '5.9.3'], engines(['5.8.3', '5.9.3'])),
      vitest: metadata(['3.2.4'], engines(['3.2.4'])),
      playwright: metadata(['1.54.0'], engines(['1.54.0'])),
      semver: metadata(['7.8.5'], engines(['7.8.5'])),
      '@types/node': metadata(['22.15.0', '24.0.0'], engines(['22.15.0', '24.0.0'])),
      express: metadata(['5.0.0', '5.1.0'], engines(['5.0.0', '5.1.0'])),
      '@types/express': metadata(['5.0.0', '5.0.1'], engines(['5.0.0', '5.0.1'])),
      fastify: metadata(['5.0.0', '5.1.0'], engines(['5.0.0', '5.1.0'])),
      'fastify-plugin': metadata(['6.0.0'], engines(['6.0.0'])),
      koa: metadata(['3.0.0', '3.1.0'], engines(['3.0.0', '3.1.0'])),
      '@types/koa': metadata(['3.0.0', '3.0.1'], engines(['3.0.0', '3.0.1'])),
      '@nestjs/common': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/core': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/platform-express': metadata(nestVersions, engines(nestVersions)),
      '@nestjs/platform-fastify': metadata(nestVersions, engines(nestVersions)),
      next: metadata(['15.0.0', '15.1.0'], engines(['15.0.0', '15.1.0'])),
      axios: metadata(['1.8.0', '1.9.0'], engines(['1.8.0', '1.9.0'])),
    },
  };
}

function npmViewForFixture(name, version) {
  const packageMetadata = fixtures().packages[name];
  return version ? { engines: packageMetadata.engines[version] ?? {} } : packageMetadata;
}

test('uses the complete npm semver evaluator and advertises only active LTS lines every selected package supports', () => {
  assert.equal(permitsNodeVersion('>=22.0.0-rc.1 <25.0.0', '22.0.0'), true);
  assert.equal(permitsNodeVersion('^22.0.0 || >=24.0.0 <25.0.0', '24.3.0'), true);

  const evidence = evaluateCompatibility(fixtures(), { now: retrievedAt, sources, packageNodeRange: '>=22.0.0 <28.0.0' });
  assert.deepEqual(evidence.node.majors, [22, 24]);
  assert.equal(evidence.versions.nestjs, '12.1.0');
  assert.equal(evidence.versions['nestjs-core'], '12.1.0');
  assert.equal(evidence.versions.semver, '7.8.5');
  assert.equal(evidence.versions.typescript, '5.9.3');

  const missingCompilerApi = fixtures();
  missingCompilerApi.packages.typescript.versions = ['5.8.3'];
  missingCompilerApi.packages.typescript.time = { '5.8.3': '2026-09-01T00:00:00.000Z' };
  assert.throws(() => evaluateCompatibility(missingCompilerApi, { now: retrievedAt, packageNodeRange: '>=22.0.0 <28.0.0' }), /required TypeScript compiler API version 5\.9\.3/);

  const futureLts = fixtures();
  futureLts.nodeSchedule.v22.end = '2026-01-01';
  futureLts.nodeSchedule.v24.end = '2026-01-01';
  assert.throws(() => evaluateCompatibility(futureLts, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /maintained.*LTS/i);

  const incompatibleExactFloor = fixtures();
  incompatibleExactFloor.packages.fastify.engines['5.1.0'] = { node: '>=22.12.0' };
  assert.throws(() => evaluateCompatibility(incompatibleExactFloor, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /fastify.*22\.0\.0/i);

  const excludesNode24 = fixtures();
  excludesNode24.packages.fastify.engines['5.1.0'] = { node: '>=22.0.0 <24.0.0' };
  assert.deepEqual(evaluateCompatibility(excludesNode24, { now: retrievedAt, packageNodeRange: '>=22.0.0' }).node, {
    floor: 22,
    majors: [22],
    versions: { 22: 'v22.18.0' },
    range: '>=22.0.0 <24.0.0',
  });

  const incompatibleTypes = fixtures();
  incompatibleTypes.packages['@types/koa'].engines['3.0.1'] = { node: '>=24.0.0' };
  assert.throws(() => evaluateCompatibility(incompatibleTypes, { now: retrievedAt, packageNodeRange: '>=22.0.0' }), /@types\/koa.*22\.0\.0/i);

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
  assert.match(markdown, /SemVer \(npm maintained range evaluator\) \| 7\.8\.5/);
  assert.match(markdown, /TypeScript is deliberately pinned to 5\.9\.3.*createSourceFile compiler API/);
  assert.match(markdown, /Next\.js \(Node engine compatibility\)/);
  assert.doesNotMatch(markdown, /restricted to its Node runtime/i);
  assert.match(markdown, /does not establish a Next\.js runtime boundary/i);
});

test('collects official sources and propagates thrown or malformed npm metadata through the CLI', async () => {
  const calls = [];
  const collected = await collectOfficialMetadata({
    fetchJson: async (url) => {
      calls.push(url);
      return url === sources.nodeSchedule ? fixtures().nodeSchedule : fixtures().nodeIndex;
    },
    npmView: npmViewForFixture,
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
    () => collectOfficialMetadata({ fetchJson: async () => { throw new Error('network unavailable'); }, npmView: npmViewForFixture }),
    /official Node metadata is unavailable/i,
  );
  await assert.rejects(
    () => collectOfficialMetadata({ fetchJson: async (url) => url === sources.nodeSchedule ? fixtures().nodeSchedule : fixtures().nodeIndex, npmView: () => { throw new Error('registry unavailable'); } }),
    /official npm metadata is unavailable/i,
  );
  await assert.rejects(
    () => collectOfficialMetadata({ fetchJson: async (url) => url === sources.nodeSchedule ? fixtures().nodeSchedule : fixtures().nodeIndex, npmView: () => ({ versions: 'not-an-array' }) }),
    /official npm metadata is unavailable or malformed/i,
  );
  await assert.rejects(
    () => runCli([], { collect: () => collectOfficialMetadata({ fetchJson: async (url) => url === sources.nodeSchedule ? fixtures().nodeSchedule : fixtures().nodeIndex, npmView: () => { throw new Error('registry unavailable'); } }) }),
    /official npm metadata is unavailable/i,
  );
});

test('parses browser and Next Edge dependency graphs to reject reachable node built-ins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cekat-browser-boundary-'));
  try {
    const browserRoot = join(root, 'src/browser');
    const edgeRoot = join(root, 'src/integrations/nextjs/edge');
    const sharedRoot = join(root, 'src/shared');
    await mkdir(browserRoot, { recursive: true });
    await mkdir(sharedRoot, { recursive: true });
    await mkdir(edgeRoot, { recursive: true });

    await writeFile(join(browserRoot, 'direct.ts'), "import /* comment */ 'node:fs';\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /direct\.ts/);

    await writeFile(join(browserRoot, 'direct.ts'), "import(`node:fs`);\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /direct\.ts/);

    await writeFile(join(browserRoot, 'direct.ts'), "const filesystem = require(`node:fs`);\nexport { filesystem };\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /direct\.ts/);

    await rm(join(browserRoot, 'direct.ts'));
    await writeFile(join(browserRoot, 'index.ts'), "export * from '../shared/browser-safe.js';\n");
    await writeFile(join(sharedRoot, 'browser-safe.ts'), "import(`node:path`);\nexport const value = 1;\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /browser-safe\.ts/);

    await rm(join(browserRoot, 'index.ts'));
    await writeFile(join(edgeRoot, 'index.ts'), "export * from '../../../shared/edge-helper.js';\n");
    await writeFile(join(sharedRoot, 'edge-helper.ts'), "const crypto = require(`node:crypto`);\nexport { crypto };\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /edge-helper\.ts/);

    await rm(join(edgeRoot, 'index.ts'));
    await writeFile(join(browserRoot, 'index.ts'), "const filesystem = (require)('node:fs');\nexport { filesystem };\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /index\.ts/);

    await writeFile(join(browserRoot, 'index.ts'), "const filesystem = require?.('node:fs');\nexport { filesystem };\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /index\.ts/);

    await writeFile(join(browserRoot, 'index.ts'), "import filesystem = require('node:fs');\nexport { filesystem };\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /index\.ts/);

    await writeFile(join(browserRoot, 'index.ts'), "export * from '../shared/missing.js';\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /Unable to resolve local browser\/Edge import/);

    await writeFile(join(browserRoot, 'index.ts'), "import { value } 'node:fs';\n");
    await assert.rejects(() => assertBrowserBoundary({ projectRoot: root }), /Unable to parse browser\/Edge source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
