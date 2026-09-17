import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageManifest from '../../package.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedSpecifiers = Object.keys(packageManifest.exports).map((subpath) => subpath === '.' ? '@cekatai/event-sdk' : `@cekatai/event-sdk/${subpath.replace(/^\.\//, '')}`);

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
    execFileSync('npm', ['install', '--ignore-scripts', tarball, 'axios', 'express', 'fastify', 'koa', '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/platform-fastify', 'next', 'typescript'], { cwd: output, stdio: 'inherit' });
    writeFileSync(join(output, 'consumer.mjs'), expectedSpecifiers.map((specifier) => `await import('${specifier}');`).join('\n'));
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: output, stdio: 'inherit' });
    // CommonJS applications (for example default NestJS projects) load the ESM package through require(esm).
    writeFileSync(join(output, 'consumer.cjs'), "const { Client } = require('@cekatai/event-sdk');\nconst { visitorMiddleware } = require('@cekatai/event-sdk/express');\nif (typeof Client !== 'function' || typeof visitorMiddleware !== 'function') throw new Error('require(esm) failed');\n");
    execFileSync(process.execPath, ['consumer.cjs'], { cwd: output, stdio: 'inherit' });
    writeFileSync(join(output, 'consumer.ts'), "import { Client } from '@cekatai/event-sdk';\nimport { Client as NodeClient } from '@cekatai/event-sdk/node';\nvoid NodeClient;\nimport { withVisitor } from '@cekatai/event-sdk/browser';\nimport { createAxiosVisitorInterceptor } from '@cekatai/event-sdk/browser/axios';\nconst client: Client = new Client('consumer-token');\nvoid client;\nvoid withVisitor;\nvoid createAxiosVisitorInterceptor;\n");
    execFileSync('npx', ['tsc', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'consumer.ts'], { cwd: output, stdio: 'inherit' });
    for (const file of filesUnder(join(output, 'node_modules/@cekatai/event-sdk/dist/browser'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/node:|async_hooks|\bClient\b|Authorization/);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 90_000);
