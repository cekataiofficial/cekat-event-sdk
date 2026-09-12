import { expect, test } from '@playwright/test';

const sameOrigin = 'http://127.0.0.1:4173';
const crossOrigin = 'http://127.0.0.1:4174';

async function reset(): Promise<void> {
  await fetch(`${sameOrigin}/control/reset`, { method: 'POST' });
}
async function requests(): Promise<Array<{ path: string; headers: Record<string, string>; body: string }>> {
  return fetch(`${sameOrigin}/control/requests`).then((response) => response.json());
}

test.beforeEach(async ({ page, context }) => {
  await reset();
  await context.addCookies([{ name: '_cekat_visitor_id', value: 'cookie-visitor', url: sameOrigin }]);
  await page.goto(sameOrigin);
  await page.waitForFunction(() => 'cekat' in window);
});

test('fetch only enriches parsed allowlisted targets and preserves explicit headers', async ({ page }) => {
  await page.evaluate(async ({ sameOrigin, crossOrigin }) => {
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [
      { origin: sameOrigin, pathPrefix: '/api/' },
      { origin: crossOrigin, pathPrefix: '/cross/' },
    ] });
    await fetch('/api/allowed', { headers: { existing: 'yes' } });
    await fetch('/outside');
    await fetch(`${crossOrigin}/cross/allowed`);
    await fetch(`${crossOrigin}/not-cross`);
    await fetch('/api/explicit', { headers: { 'X-CEKAT-VISITOR-ID': 'explicit' } });
    disable();
  }, { sameOrigin, crossOrigin });

  const observed = await requests();
  expect(observed.map(({ path }) => path)).toEqual(['/api/allowed', '/outside', '/cross/allowed', '/not-cross', '/api/explicit']);
  expect(observed.map(({ headers }) => headers['x-cekat-visitor-id'])).toEqual(['cookie-visitor', undefined, 'cookie-visitor', undefined, 'explicit']);
  expect(observed[0]?.headers.existing).toBe('yes');
});

test('fetch keeps Request body, credentials, signal, and response semantics', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] });
    const controller = new AbortController();
    const request = new Request('/api/request', { method: 'POST', body: 'body-value', credentials: 'include', signal: controller.signal });
    const response = await fetch(request);
    const sourceBody = await request.text();
    const result = { status: response.status, body: sourceBody, credentials: request.credentials, aborted: request.signal.aborted };
    disable();
    return result;
  });
  expect(result).toEqual({ status: 200, body: 'body-value', credentials: 'include', aborted: false });
  const observed = (await requests()).find(({ path }) => path === '/api/request');
  expect(observed?.body).toBe('body-value');
  expect(observed?.headers['x-cekat-visitor-id']).toBe('cookie-visitor');
});

test('fetch accepts URL input and rejects wrapper input errors asynchronously', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] });
    const urlResponse = await fetch(new URL('/api/url-input', location.href));
    const consumed = new Request('/api/consumed', { method: 'POST', body: 'consumed-body' });
    await consumed.text();

    async function rejectionBehavior(input: Request | string): Promise<{ returnedPromise: boolean; threwSynchronously: boolean; rejectedAsynchronously: boolean }> {
      let returnedPromise = false;
      let threwSynchronously = false;
      let afterCall = false;
      let rejectedAsynchronously = false;
      try {
        const result = fetch(input);
        returnedPromise = result instanceof Promise;
        result.catch(() => { rejectedAsynchronously = afterCall; });
        afterCall = true;
        await result.catch(() => undefined);
      } catch {
        threwSynchronously = true;
      }
      return { returnedPromise, threwSynchronously, rejectedAsynchronously };
    }

    const result = {
      urlStatus: urlResponse.status,
      consumed: await rejectionBehavior(consumed),
      malformed: await rejectionBehavior('http://%'),
    };
    disable();
    return result;
  });

  expect(result).toEqual({
    urlStatus: 200,
    consumed: { returnedPromise: true, threwSynchronously: false, rejectedAsynchronously: true },
    malformed: { returnedPromise: true, threwSynchronously: false, rejectedAsynchronously: true },
  });
  const observed = (await requests()).find(({ path }) => path === '/api/url-input');
  expect(observed?.headers['x-cekat-visitor-id']).toBe('cookie-visitor');
});

test('uses one idempotent installation and restores the exact fetch method', async ({ page }) => {
  const result = await page.evaluate(() => {
    const original = window.fetch;
    const first = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: 'HTTP://127.0.0.1:4173:80'.replace(':4173:80', ':4173'), pathPrefix: '/api/' }] });
    const second = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] });
    let differentThrows = false;
    try { window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/other/' }] }); } catch { differentThrows = true; }
    first();
    const restored = window.fetch === original;
    second();
    return { sameDisable: first === second, differentThrows, restored };
  });
  expect(result).toEqual({ sameDisable: true, differentThrows: true, restored: true });
});

declare global { interface Window { cekat: typeof import('../../src/browser/index.js'); } }
