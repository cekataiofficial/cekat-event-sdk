import { describe, expect, it } from 'vitest';

import { detectRuntime, runtimeProductToken } from '../../src/node/runtime.js';

describe('server runtime detection', () => {
  it('prefers the Bun version because Bun also reports a Node compatibility version', () => {
    expect(detectRuntime({ node: '26.3.0', bun: '1.4.2' })).toEqual({ name: 'bun', version: '1.4.2' });
    expect(runtimeProductToken({ node: '26.3.0', bun: '1.4.2' })).toBe('bun/1.4.2');
  });

  it('reports Node when no Bun version is present', () => {
    expect(runtimeProductToken({ node: '24.18.0' })).toBe('node/24.18.0');
    expect(runtimeProductToken({ node: '24.18.0', bun: '' })).toBe('node/24.18.0');
    expect(runtimeProductToken({})).toBe('node/unknown');
  });

  it('matches the runtime executing this test', () => {
    const expected = process.versions.bun === undefined ? `node/${process.versions.node}` : `bun/${process.versions.bun}`;
    expect(runtimeProductToken()).toBe(expected);
  });
});
