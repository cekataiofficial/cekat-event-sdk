import { describe, expect, it } from 'vitest';

import { matchesAllowedTarget, normalizeAllowedTargets } from '../../src/browser/allowlist.js';

describe('normalizeAllowedTargets', () => {
  it('requires at least one target', () => {
    expect(() => normalizeAllowedTargets([])).toThrow(/at least one/i);
  });

  it.each([
    [{ origin: 'https://user:password@example.test' }],
    [{ origin: 'ftp://example.test' }],
    [{ origin: 'https://example.test/api' }],
    [{ origin: 'https://example.test/?query=value' }],
    [{ origin: 'https://example.test/#fragment' }],
    [{ origin: 'https://example.test', pathPrefix: 'api' }],
  ].map((targets) => [targets]))('rejects invalid target configuration %#', (targets) => {
    expect(() => normalizeAllowedTargets(targets)).toThrow();
  });

  it('normalizes origin case and default ports, defaults paths, then deduplicates and sorts', () => {
    expect(normalizeAllowedTargets([
      { origin: 'HTTPS://EXAMPLE.TEST:443', pathPrefix: '/z' },
      { origin: 'https://example.test' },
      { origin: 'http://EXAMPLE.TEST:80', pathPrefix: '/a' },
      { origin: 'https://example.test/', pathPrefix: '/z' },
    ])).toEqual([
      { origin: 'http://example.test', pathPrefix: '/a' },
      { origin: 'https://example.test', pathPrefix: '/' },
      { origin: 'https://example.test', pathPrefix: '/z' },
    ]);
  });
});

describe('matchesAllowedTarget', () => {
  const targets = normalizeAllowedTargets([
    { origin: 'https://api.example.test', pathPrefix: '/collect/' },
  ]);

  it('matches parsed origin equality and pathname prefix', () => {
    expect(matchesAllowedTarget(targets, new URL('https://api.example.test/collect/event?source=web'))).toBe(true);
    expect(matchesAllowedTarget(targets, new URL('https://api.example.test/collect/'))).toBe(true);
    expect(matchesAllowedTarget(targets, new URL('https://api.example.test/collection/event'))).toBe(false);
    expect(matchesAllowedTarget(targets, new URL('https://other.example.test/collect/event'))).toBe(false);
  });

  it('does not use raw URL prefixes', () => {
    expect(matchesAllowedTarget(targets, new URL('https://api.example.test.evil.test/collect/event'))).toBe(false);
    expect(matchesAllowedTarget(targets, new URL('https://api.example.test@evil.test/collect/event'))).toBe(false);
  });
});
