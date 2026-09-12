import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { visitorMiddleware } from '../../src/integrations/express.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  expect(currentVisitorId()).toBeUndefined();
});

async function request(app: express.Express, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  return fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
}

function appWithVisitor(handler: express.RequestHandler): express.Express {
  const app = express();
  app.use(visitorMiddleware());
  app.get('/visitor', handler);
  return app;
}

describe('Express visitor middleware', () => {
  it('uses header, cookie, or neither without changing request or response semantics', async () => {
    const app = appWithVisitor(async (req, response) => {
      const headersBefore = JSON.stringify(req.headers);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      response.status(202).set('x-downstream', 'preserved').json({
        visitorId: currentVisitorId() ?? null,
        headersUnchanged: headersBefore === JSON.stringify(req.headers),
      });
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

  it('isolates parallel requests after awaited timers and leaves no ambient visitor', async () => {
    const app = appWithVisitor(async (_request, response) => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      response.json({ visitorId: currentVisitorId() ?? null });
    });

    const visitorIds = Array.from({ length: 20 }, (_, index) => `express-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId) => request(app, '/visitor', {
      'x-cekat-visitor-id': visitorId,
    })));

    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      visitorIds.map((visitorId) => ({ visitorId })),
    );
  });

  it('preserves downstream thrown error behavior and cleans up its visitor scope', async () => {
    const app = express();
    app.use(visitorMiddleware());
    app.get('/throws', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(currentVisitorId()).toBe('express-error');
      throw new Error('downstream failure');
    });
    app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(503).json({ message: error.message, visitorId: currentVisitorId() ?? null });
    });

    const response = await request(app, '/throws', { 'x-cekat-visitor-id': 'express-error' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ message: 'downstream failure', visitorId: 'express-error' });
  });
});
