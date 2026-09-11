import { describe, expect, it } from 'vitest';

import {
  currentVisitorId,
  runWithVisitorFromHeaders,
  runWithVisitorFromRequest,
  runWithVisitorId,
} from '../../src/node/visitor-context.js';

describe('visitor request scope', () => {
  it('uses a case-insensitive nonblank visitor header before the cookie and trims it', () => {
    const result = runWithVisitorFromRequest({
      headers: {
        'x-CEKAT-visitor-id': ' header-visitor \t',
        cookie: '_cekat_visitor_id=cookie-visitor',
      },
    }, currentVisitorId);

    expect(result).toBe('header-visitor');
  });

  it('uses the first nonblank array header value before the cookie', () => {
    const result = runWithVisitorFromRequest({
      headers: {
        'X-Cekat-Visitor-ID': [' \t ', ' first-visitor ', 'later-visitor'],
        cookie: '_cekat_visitor_id=cookie-visitor',
      },
    }, currentVisitorId);

    expect(result).toBe('first-visitor');
  });

  it('falls back to the exact cookie name without decoding or authenticating it', () => {
    const cookieVisitor = runWithVisitorFromHeaders(
      new Headers({ cookie: 'other=_cekat_visitor_id=wrong; _cekat_visitor_id= raw%2Fvisitor=token ; ignored=value' }),
      undefined,
      currentVisitorId,
    );
    const exactName = runWithVisitorFromHeaders(
      { Cookie: 'not_cekat_visitor_id=wrong; _cekat_visitor_id= cookie-visitor ' },
      undefined,
      currentVisitorId,
    );

    expect(cookieVisitor).toBe('raw%2Fvisitor=token');
    expect(exactName).toBe('cookie-visitor');
  });

  it('treats blank header and cookie values as absent', () => {
    expect(runWithVisitorFromHeaders(
      { 'X-CEKAT-VISITOR-ID': ' \n ' },
      ' _cekat_visitor_id=\t ; another=value',
      currentVisitorId,
    )).toBeUndefined();
    expect(currentVisitorId()).toBeUndefined();
  });

  it('preserves callback returns and rejections', async () => {
    const marker = { result: 'value' };
    const failure = new Error('callback rejection');

    expect(runWithVisitorId(' visitor ', () => marker)).toBe(marker);
    await expect(runWithVisitorId('visitor', async () => {
      await Promise.resolve();
      expect(currentVisitorId()).toBe('visitor');
      throw failure;
    })).rejects.toBe(failure);
    expect(currentVisitorId()).toBeUndefined();
  });

  it('restores nested scopes and cleans up after a throw', () => {
    expect(runWithVisitorId(' outer ', () => {
      expect(currentVisitorId()).toBe('outer');
      expect(runWithVisitorId(' inner ', currentVisitorId)).toBe('inner');
      expect(currentVisitorId()).toBe('outer');
      expect(() => runWithVisitorId('throwing', () => {
        expect(currentVisitorId()).toBe('throwing');
        throw new Error('expected');
      })).toThrow('expected');
      return currentVisitorId();
    })).toBe('outer');
    expect(currentVisitorId()).toBeUndefined();
  });

  it('retains a visitor across promises and timers', async () => {
    const visitor = await runWithVisitorId(' async-visitor ', async () => {
      await Promise.resolve();
      expect(currentVisitorId()).toBe('async-visitor');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return currentVisitorId();
    });

    expect(visitor).toBe('async-visitor');
    expect(currentVisitorId()).toBeUndefined();
  });

  it('isolates 100 parallel request scopes without leakage', async () => {
    const visitorIds = Array.from({ length: 100 }, (_, index) => `visitor-${index}`);
    const observed = await Promise.all(visitorIds.map((visitorId, index) => runWithVisitorFromRequest({
      headers: {
        'x-cekat-visitor-id': ` ${visitorId} `,
        cookie: `_cekat_visitor_id=wrong-${index}`,
      },
    }, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, index % 5));
      const afterTimer = currentVisitorId();
      await Promise.resolve();
      return [afterTimer, currentVisitorId()] as const;
    })));

    expect(observed).toEqual(visitorIds.map((visitorId) => [visitorId, visitorId]));
    expect(currentVisitorId()).toBeUndefined();
  });
});
