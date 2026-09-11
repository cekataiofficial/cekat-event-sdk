import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageManifest from '../../package.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedSubpaths = Object.keys(packageManifest.exports).map((subpath) => subpath.replace(/^\.\//, ''));

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('published exports resolve in a clean packed consumer and browser artifacts contain no Node SDK graph', () => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  execFileSync('node', ['scripts/check-exports.mjs'], { cwd: root, stdio: 'inherit' });
  const output = mkdtempSync(join(tmpdir(), 'cekat-event-sdk-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8' }));
    const tarball = join(output, packed[0].filename);
    execFileSync('npm', ['init', '-y'], { cwd: output, stdio: 'ignore' });
    execFileSync('npm', ['install', '--ignore-scripts', tarball, 'axios', 'express', 'fastify', 'fastify-plugin', 'koa', '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/platform-fastify', 'next', 'typescript'], { cwd: output, stdio: 'inherit' });
    writeFileSync(join(output, 'consumer.mjs'), expectedSubpaths.map((subpath) => `await import('@cekat/event-sdk/${subpath}');`).join('\n'));
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: output, stdio: 'inherit' });
    writeFileSync(join(output, 'consumer.ts'), "import { Client } from '@cekat/event-sdk/node';\nimport { withVisitor } from '@cekat/event-sdk/browser';\nimport { createAxiosVisitorInterceptor } from '@cekat/event-sdk/browser/axios';\nconst client: Client = new Client('consumer-token');\nvoid client;\nvoid withVisitor;\nvoid createAxiosVisitorInterceptor;\n");
    execFileSync('npx', ['tsc', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'consumer.ts'], { cwd: output, stdio: 'inherit' });
    for (const file of filesUnder(join(output, 'node_modules/@cekat/event-sdk/dist/browser'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/node:|async_hooks|\bClient\b|Authorization/);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 90_000);
