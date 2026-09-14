import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { currentVisitorId, runWithVisitorId } from '../../src/node/visitor-context.js';

/**
 * The visitor scope relies on AsyncLocalStorage. These boundaries run on every supported runtime
 * (Node.js and Bun) because a lost scope would silently drop visitor_id rather than fail.
 */
describe('visitor scope propagation across asynchronous boundaries', () => {
  const boundaries: Record<string, () => Promise<string | undefined>> = {
    'awaited promise': async () => { await Promise.resolve(); return currentVisitorId(); },
    setTimeout: () => new Promise((resolve) => { setTimeout(() => resolve(currentVisitorId()), 1); }),
    'timers/promises': async () => { await delay(1); return currentVisitorId(); },
    setImmediate: () => new Promise((resolve) => { setImmediate(() => resolve(currentVisitorId())); }),
    setInterval: () => new Promise((resolve) => {
      const interval = setInterval(() => { clearInterval(interval); resolve(currentVisitorId()); }, 1);
    }),
    queueMicrotask: () => new Promise((resolve) => { queueMicrotask(() => resolve(currentVisitorId())); }),
    'process.nextTick': () => new Promise((resolve) => { process.nextTick(() => resolve(currentVisitorId())); }),
    'custom thenable': async () => {
      const thenable = { then(resolve: (value: string | undefined) => void) { setTimeout(() => resolve(currentVisitorId()), 1); } };
      return await thenable;
    },
    'async generator': async () => {
      async function* values() { await delay(1); yield currentVisitorId(); }
      for await (const value of values()) return value;
      return undefined;
    },
    'Promise.all of timers': async () => {
      const values = await Promise.all([delay(1).then(currentVisitorId), delay(2).then(currentVisitorId)]);
      return values.every((value) => value === values[0]) ? values[0] : 'mismatch';
    },
    'EventEmitter emitted inside the scope': async () => {
      const emitter = new EventEmitter();
      const observed = once(emitter, 'event');
      setTimeout(() => emitter.emit('event', currentVisitorId()), 1);
      const [value] = await observed as [string | undefined];
      return value;
    },
    'stream pipeline': async () => {
      let observed: string | undefined;
      await pipeline(Readable.from(['chunk']), async function* consume(source) {
        for await (const _chunk of source) observed = currentVisitorId();
      });
      return observed;
    },
    'AbortController abort listener': () => new Promise((resolve) => {
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => resolve(currentVisitorId()), { once: true });
      setTimeout(() => controller.abort(), 1);
    }),
    'EventTarget dispatched from a timer': () => new Promise((resolve) => {
      const target = new EventTarget();
      target.addEventListener('event', () => resolve(currentVisitorId()), { once: true });
      setTimeout(() => target.dispatchEvent(new Event('event')), 1);
    }),
    'ReadableStream pull': async () => {
      const stream = new ReadableStream<string | undefined>({ pull(controller) { controller.enqueue(currentVisitorId()); controller.close(); } });
      return (await stream.getReader().read()).value;
    },
    'crypto.subtle': async () => { await crypto.subtle.digest('SHA-256', new Uint8Array(1)); return currentVisitorId(); },
    'fetch to a local server': async () => {
      const server = createServer((_request, response) => { response.end('ok'); });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP address');
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        await response.text();
        return currentVisitorId();
      } finally {
        server.close();
      }
    },
  };

  for (const [name, boundary] of Object.entries(boundaries)) {
    it(`keeps the visitor across ${name}`, async () => {
      await expect(runWithVisitorId(`visitor-${name}`, boundary)).resolves.toBe(`visitor-${name}`);
      expect(currentVisitorId()).toBeUndefined();
    });
  }

  it('keeps 50 concurrent scopes isolated across mixed boundaries', async () => {
    const names = Object.keys(boundaries).filter((name) => name !== 'fetch to a local server');
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => {
      const boundary = boundaries[names[index % names.length]!]!;
      return runWithVisitorId(`visitor-${index}`, async () => [await boundary(), currentVisitorId()]);
    }));
    expect(results).toEqual(Array.from({ length: 50 }, (_, index) => [`visitor-${index}`, `visitor-${index}`]));
  });

  /**
   * Bun does not restore AsyncLocalStorage for these native event sources (verified on Bun 1.2.5,
   * 1.2.23, 1.3.0, 1.3.14, 1.4.0, and 1.4.2). The SDK is unaffected because it reads the visitor synchronously when a call starts; code
   * that tracks events from such callbacks must capture currentVisitorId() first. README documents it.
   * If a Bun release restores the scope, this test fails so the documentation can be updated.
   */
  const runtimeDifferences: Record<string, () => Promise<string | undefined>> = {
    'AbortSignal.timeout listener': () => new Promise((resolve) => {
      AbortSignal.timeout(1).addEventListener('abort', () => resolve(currentVisitorId()), { once: true });
    }),
    'MessageChannel message': () => new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.addEventListener('message', () => { port1.close(); resolve(currentVisitorId()); }, { once: true });
      port1.start();
      setTimeout(() => port2.postMessage('message'), 1);
    }),
  };

  for (const [name, boundary] of Object.entries(runtimeDifferences)) {
    it(`${process.versions.bun === undefined ? 'keeps' : 'does not keep (Bun limitation)'} the visitor across ${name}`, async () => {
      const expected = process.versions.bun === undefined ? `visitor-${name}` : undefined;
      await expect(runWithVisitorId(`visitor-${name}`, boundary)).resolves.toBe(expected);
    });
  }

  it('does not leak a scope into callbacks registered outside it', async () => {
    const emitter = new EventEmitter();
    const observed = once(emitter, 'event');
    await runWithVisitorId('inside', async () => { emitter.emit('event', 'emitted'); });
    await observed;
    await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
    expect(currentVisitorId()).toBeUndefined();
  });
});
