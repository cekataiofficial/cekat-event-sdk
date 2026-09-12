import { afterEach, describe, expect, it } from 'vitest';
import { AxiosHeaders } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

import { createAxiosVisitorInterceptor } from '../../src/browser/axios.js';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function setCookie(cookie: string): void {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie } });
}

function config(headers: InternalAxiosRequestConfig['headers']): InternalAxiosRequestConfig {
  return { headers, method: 'get', url: '/events' } as InternalAxiosRequestConfig;
}

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else Object.defineProperty(globalThis, 'document', originalDocument);
});

describe('createAxiosVisitorInterceptor', () => {
  it('copies AxiosHeaders without mutating the config or header instance', () => {
    setCookie('_cekat_visitor_id= axios-visitor ');
    const headers = new AxiosHeaders({ existing: 'preserved' });
    const input = config(headers);

    const output = createAxiosVisitorInterceptor()(input);

    expect(output).not.toBe(input);
    expect(output.headers).toBeInstanceOf(AxiosHeaders);
    expect(output.headers).not.toBe(headers);
    expect(AxiosHeaders.from(output.headers).get('existing')).toBe('preserved');
    expect(AxiosHeaders.from(output.headers).get('x-cekat-visitor-id')).toBe('axios-visitor');
    expect(headers.has('x-cekat-visitor-id')).toBe(false);
    expect(input.headers).toBe(headers);
  });

  it('copies plain headers and preserves an explicit visitor case-insensitively', () => {
    setCookie('_cekat_visitor_id=cookie-visitor');
    const headers = { existing: 'preserved', 'X-CEKAT-VISITOR-ID': 'explicit-visitor' };
    const input = config(headers as unknown as InternalAxiosRequestConfig['headers']);

    const output = createAxiosVisitorInterceptor()(input);

    expect(output).not.toBe(input);
    expect(output.headers).toBeInstanceOf(AxiosHeaders);
    expect(AxiosHeaders.from(output.headers).get('x-cekat-visitor-id')).toBe('explicit-visitor');
    expect(headers).toEqual({ existing: 'preserved', 'X-CEKAT-VISITOR-ID': 'explicit-visitor' });
    expect(input.headers).toBe(headers);
  });
});
