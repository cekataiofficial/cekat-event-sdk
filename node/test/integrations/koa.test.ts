import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';

import { visitorMiddleware } from '../../src/integrations/koa.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  expect(currentVisitorId()).toBeUndefined();
});

async function request(app: Koa, path: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
  const server = createServer(app.callback());
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  return fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
}

function appWithVisitor(handler: Koa.Middleware): Koa {
  const app = new Koa();
  app.use(visitorMiddleware());
  app.use(handler);
  return app;
}

describe('Koa visitor middleware', () => {
  it('uses header, cookie, or neither while preserving onion scope and response semantics', async () => {
    const app = appWithVisitor(async (context) => {
      const headersBefore = JSON.stringify(context.headers);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      context.status = 202;
      context.set('x-downstream', 'preserved');
      context.body = {
        visitorId: currentVisitorId() ?? null,
        headersUnchanged: headersBefore === JSON.stringify(context.headers),
      };
    });

    let emitted = 0;
    (app as unknown as NodeJS.EventEmitter).on('cekat-visitor', () => { emitted += 1; });

    const fromHeader = await request(app, '/visitor', {
      'x-cekat-visitor-id': ' header-visitor ',
      cookie: '_cekat_visitor_id=cookie-visitor',
    });
    const fromCookie = await request(app, '/visitor', { cookie: '_cekat_visitor_id= cookie-visitor ' });
    const fromNeither = await request(app, '/visitor');

    expect(fromHeader.status).toBe(202);
    expect(fromHeader.headers.get('x-downstream')).toBe('preserved');
    expect(fromHeader.headers.get('set-cookie')).toBeNull();
    await expect(fromHeader.json()).resolves.toEqual({ visitorId: 'header-visitor', headersUnchanged: true });
    await expect(fromCookie.json()).resolves.toEqual({ visitorId: 'cookie-visitor', headersUnchanged: true });
    await expect(fromNeither.json()).resolves.toEqual({ visitorId: null, headersUnchanged: true });
    expect(emitted).toBe(0);
  });

  it('isolates parallel requests after awaited timers', async () => {
    const app = appWithVisitor(async (context) => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      context.body = { visitorId: currentVisitorId() ?? null };
    });

    const visitorIds = Array.from({ length: 20 }, (_, index) => `koa-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId) => request(app, '/visitor', {
      'x-cekat-visitor-id': visitorId,
    })));

    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      visitorIds.map((visitorId) => ({ visitorId })),
    );
  });

  it('keeps the visitor through promise-based body parsing on parallel POST requests', async () => {
    const app = new Koa();
    app.use(visitorMiddleware());
    app.use(async (context, next) => {
      const chunks: Buffer[] = [];
      for await (const chunk of context.req) chunks.push(chunk as Buffer);
      context.state.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await next();
    });
    app.use(async (context) => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      context.body = { visitorId: currentVisitorId() ?? null, orderId: (context.state.body as { orderId: string }).orderId };
    });

    const visitorIds = Array.from({ length: 10 }, (_, index) => `koa-post-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId, index) => request(app, '/orders', {
      'x-cekat-visitor-id': visitorId,
      'content-type': 'application/json',
    }, { method: 'POST', body: JSON.stringify({ orderId: `order-${index}`, padding: 'x'.repeat(64_000) }) })));

    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      visitorIds.map((visitorId, index) => ({ visitorId, orderId: `order-${index}` })),
    );
  });

  it('preserves downstream throw behavior and keeps onion unwinding in scope', async () => {
    const app = new Koa();
    app.use(visitorMiddleware());
    app.use(async (_context, next) => {
      try {
        await next();
      } catch (error) {
        expect(currentVisitorId()).toBe('koa-error');
        throw error;
      }
    });
    app.use(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(currentVisitorId()).toBe('koa-error');
      throw new Error('downstream failure');
    });
    app.on('error', () => undefined);

    const response = await request(app, '/throws', { 'x-cekat-visitor-id': 'koa-error' });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Internal Server Error');
  });
});
