import { afterEach, describe, expect, it } from 'vitest';

import * as nextNodeRuntimeFixture from './nextjs-node-runtime.fixture.js';
import { runWithCekatVisitor, withCekatVisitor } from '../../src/integrations/nextjs.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

afterEach(() => {
  delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
  expect(currentVisitorId()).toBeUndefined();
});

describe('Next.js Node-runtime visitor wrappers', () => {
  it('executes the typed Node-runtime App Router fixture', async () => {
    const response = nextNodeRuntimeFixture.GET(new Request('https://example.test/route', {
      headers: { 'x-cekat-visitor-id': 'fixture-visitor' },
    }));

    expect(nextNodeRuntimeFixture.runtime).toBe('nodejs');
    expect(nextNodeRuntimeFixture.default).toBeTypeOf('function');
    await expect(response.json()).resolves.toEqual({ visitorId: 'fixture-visitor' });
  });

  it('scopes Pages/API Node request headers through awaited handlers and preserves the returned result', async () => {
    const handler = withCekatVisitor(async (request: { headers: Record<string, string | string[] | undefined> }, response: { statusCode: number }) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { visitorId: currentVisitorId(), response, request };
    });
    const request = { headers: { 'X-Cekat-Visitor-ID': ' page-header ', cookie: '_cekat_visitor_id=page-cookie' } };
    const response = { statusCode: 202 };

    await expect(handler(request, response)).resolves.toEqual({ visitorId: 'page-header', response, request });
  });

  it('uses cookie fallback and isolates parallel Page/API wrappers', async () => {
    const handler = withCekatVisitor(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      return currentVisitorId();
    });

    await expect(handler({ headers: { cookie: '_cekat_visitor_id= page-cookie ' } }, {})).resolves.toBe('page-cookie');
    const visitorIds = Array.from({ length: 20 }, (_, index) => `next-page-${index}`);
    await expect(Promise.all(visitorIds.map((visitorId) => handler({ headers: { 'x-cekat-visitor-id': visitorId } }, {})))).resolves.toEqual(visitorIds);
  });

  it('scopes App Router Web Requests through awaited handlers and preserves results', async () => {
    const request = new Request('https://example.test/route', {
      headers: { 'x-cekat-visitor-id': ' app-header ', cookie: '_cekat_visitor_id=app-cookie' },
    });

    await expect(runWithCekatVisitor(request, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { visitorId: currentVisitorId(), result: 'preserved' };
    })).resolves.toEqual({ visitorId: 'app-header', result: 'preserved' });
  });

  it('preserves handler rejection identity', async () => {
    const expected = new Error('downstream failure');
    const handler = withCekatVisitor(async () => {
      await Promise.resolve();
      throw expected;
    });

    await expect(handler({ headers: { 'x-cekat-visitor-id': 'failure-visitor' } }, {})).rejects.toBe(expected);
  });

  it('best-effort rejects an Edge marker only after this Node-only module has loaded', () => {
    (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = 'edge-runtime';
    const pagesHandler = withCekatVisitor(() => 'unreachable');
    const request = new Request('https://example.test/route');

    expect(() => pagesHandler({ headers: {} }, {})).toThrow('Next.js Edge runtime is unsupported; use the Node.js runtime');
    expect(() => runWithCekatVisitor(request, () => 'unreachable')).toThrow('Next.js Edge runtime is unsupported; use the Node.js runtime');
  });
});
