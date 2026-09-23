import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findApprovedRangeDrift } from '../../scripts/check-approved-outdated.mjs';
import { normalizeAndValidateManifestArtifacts } from '../../scripts/package';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/package');

function run(args, options = {}) {
  return spawnSync(script, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
    ...options,
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertManifest(output) {
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['artifacts', 'language', 'schema_version', 'version']);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.language, 'node');
  assert.equal(manifest.version, '0.3.0');
  assert.ok(manifest.artifacts.length > 0);

  const paths = manifest.artifacts.map((artifact) => artifact.path);
  assert.deepEqual(paths, [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
  assert.equal(new Set(paths).size, paths.length);
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.path, /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\\\0]+$/);
    const path = resolve(output, artifact.path);
    assert.equal(relative(output, path).startsWith('..'), false);
    assert.equal(statSync(path).isFile(), true);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(artifact.sha256, sha256(path));
    assert.equal(artifact.size_bytes, statSync(path).size);
  }
  return manifest;
}

test('rejects malformed, unsafe, and dirty output requests before package validation', (t) => {
  if (process.env.CEKAT_PACKAGE_VALIDATION === '1') {
    t.skip('the package validation run does not recursively invoke package contract subprocesses');
    return;
  }
  assert.equal(run([]).status, 2);
  assert.equal(run(['--version', '0.3.0', '--output', 'relative']).status, 2);
  assert.equal(run(['--version', '0.1.1', '--output', '/tmp/cekat-package-test']).status, 2);
  assert.equal(run(['--version', '0.3.0', '--output', '/tmp/../tmp/cekat-package-test']).status, 2);
  assert.equal(run(['--version', '0.3.0', '--output', root]).status, 2);

  const output = mkdtempSync(join(tmpdir(), 'cekat-package-dirty-'));
  const symlinkOutput = mkdtempSync(join(tmpdir(), 'cekat-package-symlink-'));
  const linkedOutput = `${symlinkOutput}-link`;
  try {
    writeFileSync(join(output, 'stale-generated-artifact.tgz'), 'stale');
    const dirtyResult = run(['--version', '0.3.0', '--output', output]);
    assert.equal(dirtyResult.status, 2);
    assert.match(dirtyResult.stderr, /empty/i);

    symlinkSync(symlinkOutput, linkedOutput);
    const symlinkResult = run(['--version', '0.3.0', '--output', linkedOutput]);
    assert.equal(symlinkResult.status, 2);
    assert.match(symlinkResult.stderr, /symbolic link/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(linkedOutput, { force: true });
    rmSync(symlinkOutput, { recursive: true, force: true });
  }
});

test('creates deterministic, hashed no-publish artifacts', { timeout: 900_000 }, (t) => {
  if (process.env.CEKAT_PACKAGE_VALIDATION === '1') {
    t.skip('the package validation run executes this suite; skip recursive package preparation');
    return;
  }
  const first = mkdtempSync(join(tmpdir(), 'cekat-package-first-'));
  const second = mkdtempSync(join(tmpdir(), 'cekat-package-second-'));
  try {
    for (const output of [first, second]) {
      const result = run(['--version', '0.3.0', '--output', output]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }

    const firstManifest = assertManifest(first);
    const secondManifest = assertManifest(second);
    assert.deepEqual(secondManifest, firstManifest);
    assert.deepEqual(
      firstManifest.artifacts.map(({ path }) => readFileSync(join(first, path))),
      secondManifest.artifacts.map(({ path }) => readFileSync(join(second, path))),
    );
    assert.equal(firstManifest.artifacts.filter(({ path }) => path.endsWith('.tgz')).length, 1);
    assert.deepEqual(
      readdirSync(first).sort(),
      [...firstManifest.artifacts.map(({ path }) => path), 'manifest.json'].sort(),
    );
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('normalizes reverse-sorted manifest artifacts and rejects incorrect hashes', async (t) => {
  const output = mkdtempSync(join(tmpdir(), 'cekat-manifest-artifacts-'));
  try {
    const alpha = join(output, 'alpha.tgz');
    const nested = join(output, 'nested');
    const zebra = join(nested, 'zebra.tgz');
    mkdirSync(nested);
    writeFileSync(alpha, 'alpha');
    writeFileSync(zebra, 'zebra');
    const reverseSortedArtifacts = [
      { path: 'nested/zebra.tgz', sha256: sha256(zebra), size_bytes: statSync(zebra).size },
      { path: 'alpha.tgz', sha256: sha256(alpha), size_bytes: statSync(alpha).size },
    ];

    const normalized = await normalizeAndValidateManifestArtifacts(output, reverseSortedArtifacts);
    assert.deepEqual(normalized.map(({ path }) => path), ['alpha.tgz', 'nested/zebra.tgz']);

    await assert.rejects(
      normalizeAndValidateManifestArtifacts(output, [
        { ...reverseSortedArtifacts[0], sha256: '0'.repeat(64) },
        reverseSortedArtifacts[1],
      ]),
      /SHA-256 does not match artifact: nested\/zebra\.tgz/,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('rejects manifest artifacts reached through nested ancestor symlinks', async (t) => {
  const output = mkdtempSync(join(tmpdir(), 'cekat-manifest-output-'));
  const outside = mkdtempSync(join(tmpdir(), 'cekat-manifest-outside-'));
  try {
    const externalArtifact = join(outside, 'external.tgz');
    writeFileSync(externalArtifact, 'external artifact');
    try {
      symlinkSync(outside, join(output, 'linked'));
    } catch (error) {
      if (error && typeof error === 'object' && ['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
        t.skip(`symbolic link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      normalizeAndValidateManifestArtifacts(output, [{
        path: 'linked/external.tgz',
        sha256: sha256(externalArtifact),
        size_bytes: statSync(externalArtifact).size,
      }]),
      /unsafe artifact path: linked\/external\.tgz/,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('permits newer versions outside exact approved dependency ranges', () => {
  assert.deepEqual(findApprovedRangeDrift({
    typescript: { current: '5.9.3', wanted: '5.9.3', latest: '7.0.2' },
    jsdom: { current: '26.1.0', wanted: '26.1.0', latest: '30.0.1' },
  }), []);
  assert.deepEqual(findApprovedRangeDrift({ fastify: { current: '5.12.3', wanted: '5.12.4' } }), [
    'fastify: installed 5.12.3, approved range resolves to 5.12.4',
  ]);
});

test('packs the package-local license and no source test files', () => {
  const output = mkdtempSync(join(tmpdir(), 'cekat-package-license-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8' }));
    const tarball = join(output, packed[0].filename);
    execFileSync('tar', ['-xzf', tarball, '-C', output]);
    const packageRoot = join(output, 'package');
    assert.equal(readFileSync(join(packageRoot, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
    assert.equal(existsSync(join(packageRoot, 'test')), false);
    assert.equal(existsSync(join(packageRoot, 'src')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('does not contain publishing or signing subprocess invocations', () => {
  const source = readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /(?:npm\s+publish|npm['"],\s*\[\s*['"]publish|\bcosign\b|\bgpg\b|\bsigstore\b)/i);
  assert.match(source, /npm['"], \['ci'\]/);
  assert.match(source, /npm['"], \['audit'\]/);
  assert.match(source, /npm['"], \['run', 'check:approved-outdated'\]/);
  assert.match(source, /npm['"], \['pack', '--json', '--pack-destination', output\]/);
  assert.match(source, /rename\(/);
});
