import { afterEach, describe, expect, it } from 'vitest';

import { withVisitor, withVisitorRequest } from '../../src/browser/explicit.js';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function setCookie(cookie: string): void {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie } });
}

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else Object.defineProperty(globalThis, 'document', originalDocument);
});

describe('withVisitor', () => {
  it('copies headers and adds a visitor from the cookie', () => {
    setCookie('_cekat_visitor_id= visitor-1 ');
    const originalHeaders = new Headers({ existing: 'preserved' });
    const enriched = withVisitor({ headers: originalHeaders, method: 'POST' });

    expect(enriched).not.toEqual({ headers: originalHeaders, method: 'POST' });
    expect(enriched.headers).toBeInstanceOf(Headers);
    expect(enriched.headers).not.toBe(originalHeaders);
    expect(new Headers(enriched.headers).get('existing')).toBe('preserved');
    expect(new Headers(enriched.headers).get('x-cekat-visitor-id')).toBe('visitor-1');
    expect(originalHeaders.has('x-cekat-visitor-id')).toBe(false);
  });

  it('preserves an explicit visitor header case-insensitively', () => {
    setCookie('_cekat_visitor_id=cookie-visitor');
    const headers = new Headers({ 'X-CEKAT-VISITOR-ID': 'explicit-visitor' });

    const enriched = withVisitor({ headers });

    expect(new Headers(enriched.headers).get('x-cekat-visitor-id')).toBe('explicit-visitor');
    expect(headers.get('x-cekat-visitor-id')).toBe('explicit-visitor');
  });
});

describe('withVisitorRequest', () => {
  it('immutably clones request metadata, body bytes, and abort semantics while enriching headers', async () => {
    setCookie('_cekat_visitor_id= visitor-2 ');
    const controller = new AbortController();
    const request = new Request('https://example.test/collect?source=test', {
      method: 'POST',
      headers: { existing: 'preserved' },
      body: new Uint8Array([0, 1, 2, 255]),
      credentials: 'include',
      redirect: 'manual',
      referrer: 'https://referrer.test/page',
      integrity: 'sha256-test',
      keepalive: true,
      signal: controller.signal,
    });

    const enriched = withVisitorRequest(request);

    expect(enriched).not.toBe(request);
    expect(enriched.url).toBe(request.url);
    expect(enriched.method).toBe(request.method);
    expect(enriched.credentials).toBe(request.credentials);
    expect(enriched.cache).toBe(request.cache);
    expect(enriched.redirect).toBe(request.redirect);
    expect(enriched.referrer).toBe(request.referrer);
    expect(enriched.integrity).toBe(request.integrity);
    expect(enriched.keepalive).toBe(request.keepalive);
    expect(enriched.headers.get('existing')).toBe('preserved');
    expect(enriched.headers.get('x-cekat-visitor-id')).toBe('visitor-2');
    expect(request.headers.has('x-cekat-visitor-id')).toBe(false);
    expect(Array.from(new Uint8Array(await enriched.arrayBuffer()))).toEqual([0, 1, 2, 255]);

    const reason = new Error('cancelled');
    controller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(enriched.signal.aborted).toBe(true);
    expect(enriched.signal.reason).toBe(reason);
  });

  it('preserves cache mode while enriching the request', () => {
    setCookie('_cekat_visitor_id=cache-visitor');
    const request = new Request('https://example.test/collect', { cache: 'no-store' });

    expect(withVisitorRequest(request).cache).toBe('no-store');
  });

  it('preserves an explicit request visitor header without mutating the request', () => {
    setCookie('_cekat_visitor_id=cookie-visitor');
    const request = new Request('https://example.test/collect', { headers: { 'X-CEKAT-VISITOR-ID': 'explicit-visitor' } });

    const enriched = withVisitorRequest(request);

    expect(enriched.headers.get('x-cekat-visitor-id')).toBe('explicit-visitor');
    expect(request.headers.get('x-cekat-visitor-id')).toBe('explicit-visitor');
  });
});
