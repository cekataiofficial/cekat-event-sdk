import { Elysia } from 'elysia';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { currentVisitorId, runWithCekatVisitor, withCekatVisitor } from '../../src/integrations/fetch.js';
import { Client } from '../../src/node/client.js';
import { TransportError } from '../../src/node/errors.js';
import { SDK_VERSION } from '../../src/node/version.js';

type Server = ReturnType<typeof Bun.serve>;
interface Ingested { body: Record<string, unknown>; userAgent: string | null; authorization: string | null }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  expect(currentVisitorId()).toBeUndefined();
});

function serve(options: Parameters<typeof Bun.serve>[0]): Server {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, ...options } as Parameters<typeof Bun.serve>[0]);
  servers.push(server);
  return server;
}

/** A Bun.serve stand-in for the Cekat ingest API that records every request. */
function fakeIngest(delayMs = 0): { origin: string; received: Ingested[] } {
  const received: Ingested[] = [];
  const server = serve({
    async fetch(request: Request) {
      const body = await request.json() as Record<string, unknown>;
      received.push({ body, userAgent: request.headers.get('user-agent'), authorization: request.headers.get('authorization') });
      if (delayMs > 0) await Bun.sleep(delayMs);
      return Response.json({ success: true, data: { success: true, message: 'accepted', event_key: body.event_key, validated_properties: [] } });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, received };
}

async function waitFor<T>(read: () => T[], count: number): Promise<T[]> {
  for (let attempt = 0; attempt < 400 && read().length < count; attempt += 1) await Bun.sleep(5);
  return read();
}

describe('Bun.serve with the fetch integration', () => {
  it('tracks events from a wrapped fetch handler with the request visitor and a Bun User-Agent', async () => {
    const ingest = fakeIngest();
    const cekat = new Client('bun-token', { baseURL: ingest.origin });
    const app = serve({
      fetch: withCekatVisitor(async (request: Request, server: Server) => {
        const order = await request.json() as { amount: number; email: string };
        const acknowledgement = await cekat.orderPaid(order.amount, 'IDR', { email: order.email });
        return Response.json({ eventKey: acknowledgement.eventKey, visitorId: currentVisitorId(), ip: server.requestIP(request)?.address });
      }),
    });

    const response = await fetch(`http://127.0.0.1:${app.port}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cekat-visitor-id': ' bun-visitor ', cookie: '_cekat_visitor_id=cookie' },
      body: JSON.stringify({ amount: 99.5, email: 'buyer@example.test' }),
    });

    await expect(response.json()).resolves.toEqual({ eventKey: 'order_paid', visitorId: 'bun-visitor', ip: '127.0.0.1' });
    expect(ingest.received).toHaveLength(1);
    expect(ingest.received[0]).toMatchObject({
      authorization: 'Bearer bun-token',
      userAgent: `cekat-event-sdk-node/${SDK_VERSION} bun/${process.versions.bun}`,
      body: { event_key: 'order_paid', visitor_id: 'bun-visitor', email: 'buyer@example.test', properties: { amount: 99.5, currency: 'IDR' } },
    });
  });

  it('supports wrapped route handlers, cookie fallback, and no visitor', async () => {
    const app = serve({
      routes: {
        '/visitor': { GET: withCekatVisitor(() => new Response(currentVisitorId() ?? 'none')) },
      },
      fetch: () => new Response('not found', { status: 404 }),
    });
    const url = `http://127.0.0.1:${app.port}/visitor`;
    expect(await (await fetch(url, { headers: { 'x-cekat-visitor-id': '  ', cookie: 'a=1; _cekat_visitor_id= from-cookie ' } })).text()).toBe('from-cookie');
    expect(await (await fetch(url)).text()).toBe('none');
  });

  it('isolates 30 concurrent requests, including fire-and-forget events sent after the response', async () => {
    const ingest = fakeIngest(5);
    const cekat = new Client('bun-token', { baseURL: ingest.origin });
    const app = serve({
      fetch: withCekatVisitor(async (request: Request) => {
        const email = new URL(request.url).searchParams.get('email')!;
        await Bun.sleep(Math.floor(Math.random() * 5));
        void cekat.userLogin({ email }).catch(() => undefined);
        return new Response(currentVisitorId());
      }),
    });

    const bodies = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const response = await fetch(`http://127.0.0.1:${app.port}/login?email=user-${index}@example.test`, { headers: { 'x-cekat-visitor-id': `visitor-${index}` } });
      return response.text();
    }));
    expect(bodies).toEqual(Array.from({ length: 30 }, (_, index) => `visitor-${index}`));

    const received = await waitFor(() => ingest.received, 30);
    expect(received.map(({ body }) => [body.email, body.visitor_id]).sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => [`user-${index}@example.test`, `visitor-${index}`]).sort(),
    );
  });

  it('serves Hono and Elysia applications through withCekatVisitor and Hono middleware', async () => {
    const ingest = fakeIngest();
    const cekat = new Client('bun-token', { baseURL: ingest.origin });

    const hono = new Hono();
    hono.use((c, next) => runWithCekatVisitor(c.req.raw, next));
    hono.post('/signup', async (c) => {
      await cekat.userRegistration({ email: 'hono@example.test' });
      return c.text(currentVisitorId() ?? 'none');
    });
    const elysia = new Elysia().post('/signup', async () => {
      await cekat.userRegistration({ email: 'elysia@example.test' });
      return currentVisitorId() ?? 'none';
    });

    const honoServer = serve({ fetch: hono.fetch });
    const elysiaServer = serve({ fetch: withCekatVisitor(elysia.fetch) });
    const honoText = await (await fetch(`http://127.0.0.1:${honoServer.port}/signup`, { method: 'POST', headers: { 'x-cekat-visitor-id': 'hono-visitor' } })).text();
    const elysiaText = await (await fetch(`http://127.0.0.1:${elysiaServer.port}/signup`, { method: 'POST', headers: { cookie: '_cekat_visitor_id=elysia-visitor' } })).text();

    expect([honoText, elysiaText]).toEqual(['hono-visitor', 'elysia-visitor']);
    expect(ingest.received.map(({ body }) => [body.email, body.visitor_id]).sort()).toEqual([
      ['elysia@example.test', 'elysia-visitor'],
      ['hono@example.test', 'hono-visitor'],
    ]);
  });
});

describe('SDK delivery on Bun fetch and timers', () => {
  it('applies the per-attempt timeout with retries using Bun timers', async () => {
    const ingest = fakeIngest(500);
    const cekat = new Client('bun-token', { baseURL: ingest.origin, timeoutMs: 50, retryCount: 1 });
    const started = performance.now();
    const error = await cekat.userLogin({ email: 'slow@example.test' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).attempts).toBe(2);
    expect((error as TransportError).deliveryOutcomeUnknown).toBe(true);
    expect(performance.now() - started).toBeLessThan(450);
    expect(await waitFor(() => ingest.received, 2)).toHaveLength(2);
  });

  it('cancels an in-flight request through AbortSignal without retrying', async () => {
    const ingest = fakeIngest(1_000);
    const cekat = new Client('bun-token', { baseURL: ingest.origin, retryCount: 2 });
    const controller = new AbortController();
    const call = cekat.userLogin({ email: 'cancel@example.test' }, { signal: controller.signal });
    await waitFor(() => ingest.received, 1);
    controller.abort(new Error('caller cancelled'));
    await expect(call).rejects.toThrow('caller cancelled');
    await Bun.sleep(50);
    expect(ingest.received).toHaveLength(1);
  });
});
