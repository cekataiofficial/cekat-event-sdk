import { describe, expect, it } from 'vitest';

import { connectionReuseInit, detectRuntime, isBunBefore14, runtimeProductToken } from '../../src/node/runtime.js';

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

  it('disables connection reuse only on Bun releases before 1.4.0', () => {
    for (const bun of ['1.0.36', '1.1.0', '1.1.45', '1.2.0', '1.2.23', '1.3.0', '1.3.14']) {
      expect(connectionReuseInit({ node: '24.0.0', bun })).toEqual({ keepalive: false });
    }
    for (const bun of ['1.4.0', '1.4.2', '1.10.0', '2.0.0']) {
      expect(connectionReuseInit({ node: '26.3.0', bun })).toEqual({});
    }
    expect(connectionReuseInit({ node: '22.12.0' })).toEqual({});
  });

  it('identifies Bun releases before 1.4.0', () => {
    expect(isBunBefore14({ bun: '1.2.5' })).toBe(true);
    expect(isBunBefore14({ bun: '1.3.14' })).toBe(true);
    expect(isBunBefore14({ bun: '1.4.0' })).toBe(false);
    expect(isBunBefore14({ node: '24.18.0' })).toBe(false);
  });
});
