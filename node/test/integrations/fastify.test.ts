import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { visitorPlugin } from '../../src/integrations/fastify.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  expect(currentVisitorId()).toBeUndefined();
});

async function appWithVisitor(registerRoutes: (scoped: FastifyInstance) => void): Promise<FastifyInstance> {
  const app = Fastify();
  applications.push(app);
  app.register(async (scoped) => {
    await scoped.register(visitorPlugin);
    registerRoutes(scoped);
  });
  await app.ready();
  return app;
}

describe('Fastify visitor plugin', () => {
  it('uses header, cookie, or neither after an awaited timer without mutating the request or response', async () => {
    const app = await appWithVisitor((scoped) => scoped.get('/visitor', async (request, reply) => {
      const headersBefore = JSON.stringify(request.headers);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      reply.code(202).header('x-downstream', 'preserved');
      return {
        visitorId: currentVisitorId() ?? null,
        headersUnchanged: headersBefore === JSON.stringify(request.headers),
      };
    }));

    const fromHeader = await app.inject({
      method: 'GET',
      url: '/visitor',
      headers: { 'x-cekat-visitor-id': ' header-visitor ', cookie: '_cekat_visitor_id=cookie-visitor' },
    });
    const fromCookie = await app.inject({ method: 'GET', url: '/visitor', headers: { cookie: '_cekat_visitor_id= cookie-visitor ' } });
    const fromNeither = await app.inject({ method: 'GET', url: '/visitor' });

    expect(fromHeader.statusCode).toBe(202);
    expect(fromHeader.headers['x-downstream']).toBe('preserved');
    expect(fromHeader.headers['set-cookie']).toBeUndefined();
    expect(fromHeader.json()).toEqual({ visitorId: 'header-visitor', headersUnchanged: true });
    expect(fromCookie.json()).toEqual({ visitorId: 'cookie-visitor', headersUnchanged: true });
    expect(fromNeither.json()).toEqual({ visitorId: null, headersUnchanged: true });
  });

  it('isolates parallel requests and does not require global plugin registration', async () => {
    const app = await appWithVisitor((scoped) => scoped.get('/visitor', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      return { visitorId: currentVisitorId() ?? null };
    }));

    const visitorIds = Array.from({ length: 20 }, (_, index) => `fastify-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId) => app.inject({
      method: 'GET', url: '/visitor', headers: { 'x-cekat-visitor-id': visitorId },
    })));

    expect(responses.map((response) => response.json())).toEqual(visitorIds.map((visitorId) => ({ visitorId })));
  });

  it('preserves downstream rejection semantics and cleans up its scope', async () => {
    const app = await appWithVisitor((scoped) => {
      scoped.get('/throws', async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(currentVisitorId()).toBe('fastify-error');
        throw new Error('downstream failure');
      });
      scoped.setErrorHandler((error, _request, reply) => {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(503).send({ message, visitorId: currentVisitorId() ?? null });
      });
    });

    const response = await app.inject({
      method: 'GET', url: '/throws', headers: { 'x-cekat-visitor-id': 'fastify-error' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ message: 'downstream failure', visitorId: 'fastify-error' });
  });
});
