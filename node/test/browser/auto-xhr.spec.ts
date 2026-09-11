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
