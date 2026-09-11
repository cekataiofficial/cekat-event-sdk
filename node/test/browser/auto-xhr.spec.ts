import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:4173';

async function reset(): Promise<void> { await fetch(`${origin}/control/reset`, { method: 'POST' }); }
async function requests(): Promise<Array<{ path: string; headers: Record<string, string>; body: string }>> { return fetch(`${origin}/control/requests`).then((response) => response.json()); }

async function xhr(page: import('@playwright/test').Page, path: string, explicit?: string): Promise<{ returned: boolean; load: boolean; status: number }> {
  return page.evaluate(({ path, explicit }) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    if (explicit !== undefined) request.setRequestHeader('X-CEKAT-VISITOR-ID', explicit);
    request.onload = () => resolve({ returned: true, load: true, status: request.status });
    request.onerror = () => reject(new Error('XHR failed'));
    const returned = request.send('xhr-body');
    if (returned !== undefined) reject(new Error('send must return undefined'));
  }), { path, explicit });
}

test.beforeEach(async ({ page, context }) => {
  await reset();
  await context.addCookies([{ name: '_cekat_visitor_id', value: 'xhr-visitor', url: origin }]);
  await page.goto(origin);
  await page.waitForFunction(() => 'cekat' in window);
});

test('XHR enriches only allowed paths and respects explicit headers', async ({ page }) => {
  await page.evaluate(() => window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] }));
  await expect(xhr(page, '/api/allowed')).resolves.toEqual({ returned: true, load: true, status: 200 });
  await expect(xhr(page, '/outside')).resolves.toEqual({ returned: true, load: true, status: 200 });
  await expect(xhr(page, '/api/explicit', 'explicit-xhr')).resolves.toEqual({ returned: true, load: true, status: 200 });
  const observed = (await requests()).filter(({ path }) => ['/api/allowed', '/outside', '/api/explicit'].includes(path));
  expect(observed.map(({ headers }) => headers['x-cekat-visitor-id'])).toEqual(['xhr-visitor', undefined, 'explicit-xhr']);
  expect(observed.map(({ body }) => body)).toEqual(['xhr-body', 'xhr-body', 'xhr-body']);
  await page.evaluate(() => window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] })());
});

test('XHR resets target state on repeated open calls', async ({ page }) => {
  await page.evaluate(() => window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] }));
  const status = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/allowed-before-reset');
    request.open('POST', '/denied-after-reset');
    request.onload = () => resolve(request.status);
    request.onerror = () => reject(new Error('XHR failed'));
    request.send('reopened');
  }));
  expect(status).toBe(200);
  const observed = (await requests()).find(({ path }) => path === '/denied-after-reset');
  expect(observed?.headers['x-cekat-visitor-id']).toBeUndefined();
});

test('XHR applies the allowlist to cross-origin requests', async ({ page }) => {
  const crossOrigin = 'http://127.0.0.1:4174';
  const statuses = await page.evaluate(async (crossOrigin) => {
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: crossOrigin, pathPrefix: '/cross/' }] });
    const send = (path: string) => new Promise<number>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${crossOrigin}${path}`);
      request.onload = () => resolve(request.status);
      request.onerror = () => reject(new Error(`XHR failed for ${path}`));
      request.send('cross-body');
    });
    const result = await Promise.all([send('/cross/allowed'), send('/not-cross')]);
    disable();
    return result;
  }, crossOrigin);
  expect(statuses).toEqual([200, 200]);
  const observed = await requests();
  const allowed = observed.find(({ path }) => path === '/cross/allowed');
  const denied = observed.find(({ path }) => path === '/not-cross');
  expect(allowed?.headers['x-cekat-visitor-id']).toBe('xhr-visitor');
  expect(denied?.headers['x-cekat-visitor-id']).toBeUndefined();
});

test('XHR reads the visitor cookie when send is called', async ({ page }) => {
  const status = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin, pathPrefix: '/api/' }] });
    const request = new XMLHttpRequest();
    request.open('POST', '/api/cookie-at-send');
    document.cookie = '_cekat_visitor_id=updated-before-send; Path=/';
    request.onload = () => {
      disable();
      resolve(request.status);
    };
    request.onerror = () => reject(new Error('XHR failed'));
    request.send('cookie-body');
  }));
  expect(status).toBe(200);
  const observed = (await requests()).find(({ path }) => path === '/api/cookie-at-send');
  expect(observed?.headers['x-cekat-visitor-id']).toBe('updated-before-send');
});

test('XHR abort behavior and exact prototype restoration are preserved', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const prototype = XMLHttpRequest.prototype;
    const originals = { open: prototype.open, setRequestHeader: prototype.setRequestHeader, send: prototype.send };
    const disable = window.cekat.enableAutoPropagation({ allowedTargets: [{ origin: location.origin }] });
    const aborted = await new Promise<boolean>((resolve) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/abort');
      request.onabort = () => resolve(true);
      request.send('ignored');
      request.abort();
    });
    disable();
    return { aborted, restored: prototype.open === originals.open && prototype.setRequestHeader === originals.setRequestHeader && prototype.send === originals.send };
  });
  expect(result).toEqual({ aborted: true, restored: true });
});

declare global { interface Window { cekat: typeof import('../../src/browser/index.js'); } }
