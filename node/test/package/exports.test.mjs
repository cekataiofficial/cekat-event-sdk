import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedSubpaths = ['node', 'express', 'fastify', 'koa', 'nestjs', 'nextjs', 'browser', 'browser/axios'];

test('published exports resolve in a clean packed consumer and browser artifacts contain no Node SDK graph', () => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  execFileSync('node', ['scripts/check-exports.mjs'], { cwd: root, stdio: 'inherit' });
  const output = mkdtempSync(join(tmpdir(), 'cekat-event-sdk-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8' }));
    const tarball = join(output, packed[0].filename);
    execFileSync('npm', ['init', '-y'], { cwd: output, stdio: 'ignore' });
    execFileSync('npm', ['install', '--ignore-scripts', tarball, 'axios', 'express', 'fastify', 'fastify-plugin', 'koa', '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/platform-fastify', 'next', 'typescript'], { cwd: output, stdio: 'inherit' });
    const imports = expectedSubpaths.map((subpath) => `await import('@cekat/event-sdk/${subpath}');`).join('\n');
    writeFileSync(join(output, 'consumer.mjs'), imports);
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: output, stdio: 'inherit' });
    writeFileSync(join(output, 'consumer.ts'), "import { Client } from '@cekat/event-sdk/node';\nimport { withVisitor } from '@cekat/event-sdk/browser';\nimport { createAxiosVisitorInterceptor } from '@cekat/event-sdk/browser/axios';\nconst client: Client = new Client('consumer-token');\nvoid client;\nvoid withVisitor;\nvoid createAxiosVisitorInterceptor;\n");
    execFileSync('npx', ['tsc', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'consumer.ts'], { cwd: output, stdio: 'inherit' });
    for (const subpath of expectedSubpaths) expect(existsSync(join(output, 'node_modules/@cekat/event-sdk/dist', subpath === 'browser/axios' ? 'browser/axios.js' : `${subpath}/index.js`)) || subpath === 'express' || subpath === 'fastify' || subpath === 'koa' || subpath === 'nestjs' || subpath === 'nextjs').toBe(true);
    const browserFiles = execFileSync('find', ['node_modules/@cekat/event-sdk/dist/browser', '-type', 'f'], { cwd: output, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const file of browserFiles) {
      const source = readFileSync(join(output, file), 'utf8');
      expect(source).not.toMatch(/node:|async_hooks|\bClient\b|Authorization/);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 30_000);
