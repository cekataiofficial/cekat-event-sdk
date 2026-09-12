import { afterEach, describe, expect, it } from 'vitest';

import { readVisitorId } from '../../src/browser/cookie.js';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else Object.defineProperty(globalThis, 'document', originalDocument);
});

describe('readVisitorId', () => {
  it('reads and trims only the exact visitor cookie name', () => {
    expect(readVisitorId('other=_cekat_visitor_id=wrong; _cekat_visitor_id= raw%2Fvisitor=token ; ignored=value'))
      .toBe('raw%2Fvisitor=token');
  });

  it('skips malformed, unrelated, and blank matching cookies', () => {
    expect(readVisitorId('malformed; not_cekat_visitor_id=value; _cekat_visitor_id= \t ; _cekat_visitor_id= second '))
      .toBe('second');
    expect(readVisitorId('visitor=value; _cekat_visitor_id; another=value')).toBeUndefined();
  });

  it('is SSR-safe when document is absent', () => {
    delete (globalThis as { document?: Document }).document;

    expect(readVisitorId()).toBeUndefined();
  });

  it('uses document.cookie by default', () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '_cekat_visitor_id= document-visitor ' } });

    expect(readVisitorId()).toBe('document-visitor');
  });
});
