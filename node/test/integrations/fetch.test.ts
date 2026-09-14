import { Elysia } from 'elysia';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { currentVisitorId, runWithCekatVisitor, withCekatVisitor } from '../../src/integrations/fetch.js';
import { Client } from '../../src/node/client.js';
import type { FetchLike } from '../../src/node/types.js';

const acknowledgement = (eventKey: string) => new Response(JSON.stringify({
  success: true, data: { success: true, message: 'accepted', event_key: eventKey, validated_properties: [] },
}), { status: 200 });

function recordingClient(): { client: Client; payloads: Record<string, unknown>[] } {
  const payloads: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    const payload = JSON.parse(init?.body as string) as Record<string, unknown>;
    payloads.push(payload);
    return acknowledgement(String(payload.event_key));
  };
  return { client: new Client('token', { baseURL: 'https://ingest.example.test', fetch }), payloads };
}

function request(headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request('https://app.example.test/checkout', { ...init, headers });
}

describe('fetch-style visitor integration', () => {
  it.each([
    [{ 'x-cekat-visitor-id': ' header ', cookie: '_cekat_visitor_id=cookie' }, 'header'],
    [{ 'X-Cekat-Visitor-ID': '  ', cookie: 'a=1; _cekat_visitor_id= cookie ' }, 'cookie'],
    [{ cookie: '_cekat_visitor_id=raw%2Fvalue' }, 'raw%2Fvalue'],
    [{ cookie: 'other=1' }, undefined],
    [{}, undefined],
  ])('resolves %j to %s for the whole handler', async (headers, expected) => {
    const handler = withCekatVisitor(async (incoming: Request) => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
      return Response.json({ visitorId: currentVisitorId() ?? null, method: incoming.method });
    });
    const response = await handler(request(headers));
    await expect(response.json()).resolves.toEqual({ visitorId: expected ?? null, method: 'GET' });
    expect(currentVisitorId()).toBeUndefined();
  });

  it('passes this, extra arguments, synchronous results, and errors through unchanged', async () => {
    const server = { name: 'server' };
    const context = { label: 'bound' };
    const handler = withCekatVisitor(function (this: typeof context, _incoming: Request, received: typeof server) {
      return `${this.label}:${received.name}:${currentVisitorId()}`;
    });
    expect(handler.call(context, request({ 'x-cekat-visitor-id': 'v' }), server)).toBe('bound:server:v');

    const failure = new Error('handler failed');
    expect(() => withCekatVisitor(() => { throw failure; })(request())).toThrow(failure);
    await expect(withCekatVisitor(async () => { throw failure; })(request())).rejects.toBe(failure);
    expect(() => withCekatVisitor(undefined as never)).toThrow(TypeError);
    expect(currentVisitorId()).toBeUndefined();
  });

  it('leaves the request body readable and does not mutate headers', async () => {
    const handler = withCekatVisitor(async (incoming: Request) => {
      const body = await incoming.json() as { amount: number };
      return Response.json({ amount: body.amount, headers: [...incoming.headers.keys()].sort(), visitorId: currentVisitorId() });
    });
    const response = await handler(request({ 'content-type': 'application/json', 'x-cekat-visitor-id': 'poster' }, { method: 'POST', body: JSON.stringify({ amount: 5 }) }));
    await expect(response.json()).resolves.toEqual({ amount: 5, headers: ['content-type', 'x-cekat-visitor-id'], visitorId: 'poster' });
  });

  it('isolates concurrent requests and events sent from them', async () => {
    const { client, payloads } = recordingClient();
    const handler = withCekatVisitor(async (incoming: Request) => {
      const { email } = await incoming.json() as { email: string };
      await new Promise<void>((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 5)); });
      await client.userLogin({ email });
      return new Response(currentVisitorId());
    });
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => handler(request(
      { 'content-type': 'application/json', 'x-cekat-visitor-id': `visitor-${index}` },
      { method: 'POST', body: JSON.stringify({ email: `user-${index}@example.test` }) },
    ))));
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(Array.from({ length: 25 }, (_, index) => `visitor-${index}`));
    expect(payloads.map((payload) => [payload.email, payload.visitor_id]).sort()).toEqual(
      Array.from({ length: 25 }, (_, index) => [`user-${index}@example.test`, `visitor-${index}`]).sort(),
    );
  });

  it('runWithCekatVisitor works as Hono middleware', async () => {
    const { client, payloads } = recordingClient();
    const app = new Hono();
    app.use((c, next) => runWithCekatVisitor(c.req.raw, next));
    app.post('/checkout', async (c) => {
      const order = await c.req.json<{ amount: number; email: string }>();
      await client.orderPaid(order.amount, 'IDR', { email: order.email });
      return c.json({ visitorId: currentVisitorId() });
    });
    const response = await app.fetch(new Request('https://app.example.test/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: '_cekat_visitor_id=hono-visitor' }, body: JSON.stringify({ amount: 10, email: 'a@example.test' }),
    }));
    await expect(response.json()).resolves.toEqual({ visitorId: 'hono-visitor' });
    expect(payloads[0]).toMatchObject({ event_key: 'order_paid', visitor_id: 'hono-visitor', properties: { amount: 10, currency: 'IDR' } });
  });

  it('withCekatVisitor wraps a Hono or Elysia app.fetch', async () => {
    const hono = new Hono().get('/visitor', (c) => c.text(currentVisitorId() ?? 'none'));
    const elysia = new Elysia().get('/visitor', () => currentVisitorId() ?? 'none');
    for (const fetchHandler of [withCekatVisitor(hono.fetch), withCekatVisitor(elysia.fetch)]) {
      const withHeader = await fetchHandler(new Request('https://app.example.test/visitor', { headers: { 'x-cekat-visitor-id': 'framework-visitor' } }));
      const without = await fetchHandler(new Request('https://app.example.test/visitor'));
      expect(await withHeader.text()).toBe('framework-visitor');
      expect(await without.text()).toBe('none');
    }
  });
});
